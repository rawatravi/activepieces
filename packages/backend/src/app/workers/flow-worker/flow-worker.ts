import fs from 'fs-extra'
import {
    ActionType,
    ActivepiecesError,
    apId,
    CodeActionSettings,
    ErrorCode,
    ExecuteFlowOperation,
    ExecutionOutput,
    ExecutionOutputStatus,
    ExecutionType,
    File,
    FileId,
    flowHelper,
    FlowRunId,
    FlowVersion,
    FlowVersionState,
    ProjectId,
    StepOutputStatus,
    TriggerType,
} from '@activepieces/shared'
import { Sandbox, sandboxManager } from '../sandbox'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { fileService } from '../../file/file.service'
import { flowRunService } from '../../flows/flow-run/flow-run-service'
import { OneTimeJobData } from './job-data'
import { engineHelper } from '../../helper/engine-helper'
import { captureException, logger } from '../../helper/logger'
import { pieceManager } from '../../flows/common/piece-installer'
import { isNil } from '@activepieces/shared'
import { getServerUrl } from '../../helper/public-ip-utils'
import {
    PackageInfo,
} from '../../helper/package-manager'
import { codeBuilder } from '../code-worker/code-builder'
import sizeof from 'object-sizeof'
import { MAX_LOG_SIZE } from '@activepieces/shared'
import { acquireLock } from '../../helper/lock'

type InstallPiecesParams = {
    path: string
    projectId: ProjectId
    flowVersion: FlowVersion
}

type FinishExecutionParams = {
    flowRunId: FlowRunId
    logFileId: FileId
    executionOutput: ExecutionOutput
}

type LoadInputAndLogFileIdParams = {
    flowVersion: FlowVersion
    jobData: OneTimeJobData
}

type LoadInputAndLogFileIdResponse = {
    input: ExecuteFlowOperation
    logFileId?: FileId | undefined
}

const extractFlowPieces = async ({
    flowVersion,
}: {
    projectId: ProjectId
    flowVersion: FlowVersion
}): Promise<PackageInfo[]> => {
    const pieces: PackageInfo[] = []
    const steps = flowHelper.getAllSteps(flowVersion.trigger)

    for (const step of steps) {
        if (step.type === TriggerType.PIECE || step.type === ActionType.PIECE) {
            const { pieceName, pieceVersion } = step.settings
            pieces.push({
                name: pieceName,
                version: pieceVersion,
            })
        }
    }

    return pieces
}

const installPieces = async (params: InstallPiecesParams): Promise<void> => {
    const { path, flowVersion, projectId } = params
    const pieces = await extractFlowPieces({ projectId, flowVersion })

    await pieceManager.install({
        projectPath: path,
        pieces,
    })
}

const finishExecution = async (
    params: FinishExecutionParams,
): Promise<void> => {
    logger.trace(params, '[FlowWorker#finishExecution] params')

    const { flowRunId, logFileId, executionOutput } = params

    if (executionOutput.status === ExecutionOutputStatus.PAUSED) {
        await flowRunService.pause({
            flowRunId,
            logFileId,
            pauseMetadata: executionOutput.pauseMetadata,
        })
    }
    else {
        await flowRunService.finish({
            flowRunId,
            status: executionOutput.status,
            tasks: executionOutput.tasks,
            logsFileId: logFileId,
            tags: executionOutput.tags ?? [],
        })
    }
}

const loadInputAndLogFileId = async ({
    flowVersion,
    jobData,
}: LoadInputAndLogFileIdParams): Promise<LoadInputAndLogFileIdResponse> => {
    const baseInput = {
        flowVersion,
        flowRunId: jobData.runId,
        projectId: jobData.projectId,
        triggerPayload: {
            duration: 0,
            input: {},
            output: jobData.payload,
            status: StepOutputStatus.SUCCEEDED,
        },
    }

    if (jobData.executionType === ExecutionType.BEGIN) {
        return {
            input: {
                serverUrl: await getServerUrl(),
                executionType: ExecutionType.BEGIN,
                ...baseInput,
            },
        }
    }

    const flowRun = await flowRunService.getOneOrThrow({
        id: jobData.runId,
        projectId: jobData.projectId,
    })

    if (isNil(flowRun.pauseMetadata) || isNil(flowRun.logsFileId)) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: {
                message: `flowRunId=${flowRun.id}`,
            },
        })
    }

    const logFile = await fileService.getOneOrThrow({
        fileId: flowRun.logsFileId,
        projectId: jobData.projectId,
    })

    const serializedExecutionOutput = logFile.data.toString('utf-8')
    const executionOutput = JSON.parse(
        serializedExecutionOutput,
    ) as ExecutionOutput

    return {
        input: {
            serverUrl: await getServerUrl(),
            executionType: ExecutionType.RESUME,
            executionState: executionOutput.executionState,
            resumeStepMetadata: flowRun.pauseMetadata.resumeStepMetadata,
            resumePayload: jobData.payload,
            ...baseInput,
        },
        logFileId: logFile.id,
    }
}

async function executeFlow(jobData: OneTimeJobData): Promise<void> {
    logger.info(
        `[FlowWorker#executeFlow] flowRunId=${jobData.runId} executionType=${jobData.executionType}`,
    )

    const flowVersion = await flowVersionService.lockPieceVersions(
        jobData.projectId,
        await flowVersionService.getOneOrThrow(jobData.flowVersionId),
    )

    // Don't use sandbox for draft versions, since they are mutable and we don't want to cache them.
    const key =
        flowVersion.id +
        (FlowVersionState.DRAFT === flowVersion.state ? '-draft' + apId() : '')
    const sandbox = await sandboxManager.obtainSandbox(key)
    const startTime = Date.now()
    logger.info(
        `[${jobData.runId}] Executing flow ${flowVersion.id} in sandbox ${sandbox.boxId}`,
    )
    try {
        if (!sandbox.cached) {
            await sandbox.recreate()
            await downloadFiles(sandbox, jobData.projectId, flowVersion)

            const path = sandbox.getSandboxFolderPath()

            await installPieces({
                projectId: jobData.projectId,
                path,
                flowVersion,
            })

            logger.info(
                `[${jobData.runId}] Preparing sandbox ${sandbox.boxId} took ${Date.now() - startTime
                }ms`,
            )
        }
        else {
            await sandbox.clean()
            logger.info(
                `[${jobData.runId}] Reusing sandbox ${sandbox.boxId} took ${Date.now() - startTime
                }ms`,
            )
        }

        const { input, logFileId } = await loadInputAndLogFileId({
            flowVersion,
            jobData,
        })

        const { result: executionOutput } = await engineHelper.executeFlow(
            sandbox,
            input,
        )


        const logsFile = await saveToLogFile({
            fileId: logFileId,
            projectId: jobData.projectId,
            executionOutput,
        })
        
        await finishExecution({
            flowRunId: jobData.runId,
            logFileId: logsFile.id,
            executionOutput,
        })

        logger.info(
            `[FlowWorker#executeFlow] flowRunId=${jobData.runId
            } executionOutputStats=${executionOutput.status} sandboxId=${sandbox.boxId
            } duration=${Date.now() - startTime} ms`,
        )
    }
    catch (e: unknown) {
        if (e instanceof ActivepiecesError && e.error.code === ErrorCode.EXECUTION_TIMEOUT) {
            await flowRunService.finish({
                flowRunId: jobData.runId,
                status: ExecutionOutputStatus.TIMEOUT,
                tasks: 1,
                logsFileId: null,
                tags: [],
            })
        }
        else {
            await flowRunService.finish({
                flowRunId: jobData.runId,
                status: ExecutionOutputStatus.INTERNAL_ERROR,
                tasks: 0,
                logsFileId: null,
                tags: [],
            })
            sandboxManager.markAsNotCached(sandbox.boxId)
            throwErrorToRetry(e as Error, jobData.runId)
        }
    }
    finally {
        await sandboxManager.returnSandbox(sandbox.boxId)
    }
}


function throwErrorToRetry(error: Error, runId: string): void {
    captureException(error)
    logger.error(error, '[FlowWorker#executeFlow] Error executing flow run id' + runId)
    throw error
}

async function saveToLogFile({ fileId, projectId, executionOutput }: { fileId: FileId | undefined, projectId: ProjectId, executionOutput: ExecutionOutput }): Promise<File> {
    // TODO REMOVE THIS, DELETE TEMPORARY 
    if (executionOutput.status !== ExecutionOutputStatus.PAUSED) {
        executionOutput.executionState.lastStepState = {}
    }
    if (sizeof(executionOutput) > MAX_LOG_SIZE) {
        const errors = new Error('Execution Output is too large, maximum size is ' + MAX_LOG_SIZE)
        captureException(errors)
        throw errors
    }
    // END TODO REMOVE THIS, DELETE TEMPORARY

    const logsFile = await fileService.save({
        fileId,
        projectId,
        data: Buffer.from(JSON.stringify(executionOutput)),
    })
    return logsFile
}

async function downloadFiles(
    sandbox: Sandbox,
    projectId: ProjectId,
    flowVersion: FlowVersion,
): Promise<void> {
    const buildPath = sandbox.getSandboxFolderPath()
    await ensureBuildDirectory(buildPath)
    const codeSteps = await getCodeSteps(projectId, flowVersion)
    await Promise.all(
        codeSteps.map((step) =>
            codeBuilder.processCodeStep({
                codeZip: step.zipFile,
                sourceCodeId: step.sourceId,
                buildPath,
            }),
        ),
    )
}

async function ensureBuildDirectory(buildPath: string): Promise<void> {
    await fs.ensureDir(`${buildPath}/codes/`)
}

async function getCodeSteps(projectId: ProjectId, flowVersion: FlowVersion): Promise<{ sourceId: string, zipFile: Buffer }[]> {
    switch (flowVersion.state) {
        case FlowVersionState.DRAFT:
            return getCodeStepsWithLock(projectId, flowVersion)
        case FlowVersionState.LOCKED:
            return getCodeStepsWithoutLock(projectId, flowVersion)
    }
}

async function getCodeStepsWithLock(projectId: ProjectId, flowVersion: FlowVersion): Promise<{ sourceId: string, zipFile: Buffer }[]> {
    const flowLock = await acquireLock({
        key: flowVersion.id,
        timeout: 180000,
    })
    try {
        return getCodeStepsWithoutLock(projectId, flowVersion)
    }
    finally {
        flowLock.release()
    }
}

async function getCodeStepsWithoutLock(projectId: ProjectId, flowVersion: FlowVersion): Promise<{ sourceId: string, zipFile: Buffer }[]> {
    const steps = flowHelper.getAllSteps(flowVersion.trigger).filter((step) => step.type === ActionType.CODE)
    const promises = []

    for (const step of steps) {
        const codeSettings = step.settings as CodeActionSettings
        if (isNil(codeSettings.artifactSourceId)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `Missing artifactSourceId for code step ${flowVersion.id}`,
                },
            })
        }
        const promise = fileService.getOneOrThrow({
            fileId: codeSettings.artifactSourceId,
            projectId,
        })
        promises.push(promise)
    }

    const results = await Promise.all(promises)

    return results.map((sourceEntity, index) => {
        const step = steps[index]
        const codeSettings = step.settings as CodeActionSettings
        return {
            sourceId: codeSettings.artifactSourceId!,
            zipFile: sourceEntity.data,
        }
    })
}

export const flowWorker = {
    executeFlow,
}

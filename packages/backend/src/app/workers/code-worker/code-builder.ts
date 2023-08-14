import fs from 'node:fs/promises'
import decompress from 'decompress'
import { sandboxManager } from '../sandbox'
import { logger } from '../../helper/logger'
import { packageManager, PackageManagerDependencies } from '../../helper/package-manager'
import { apId } from '@activepieces/shared'
import { archiver } from '../../helper/archiver'

export const codeBuilder = {
    async build({ sourceArchiveContent }: BuildParams): Promise<BuildOutput> {
        const sandbox = await sandboxManager.obtainSandbox(apId())
        const buildPath = sandbox.getSandboxFolderPath()

        try {
            const startTime = Date.now()
            logger.info(`[CodeBuilder#build] started buildPath=${buildPath}`)

            await sandbox.recreate()
            await downloadFiles(sourceArchiveContent, buildPath)

            const dependencies: PackageManagerDependencies = {
                '@tsconfig/node18': {
                    version: '1.0.0',
                },
                typescript: {
                    version: '4.8.4',
                },
            }

            await packageManager.addDependencies(buildPath, dependencies)
            await packageManager.runLocalDependency(buildPath, 'tsc')

            const filePromises = ['index.js', 'package.json']
                .map(async (fileName) => ({
                    name: fileName,
                    content: await fs.readFile(`${buildPath}/${fileName}`),
                }))

            const files = await Promise.all(filePromises)
            const archiveContent = await archiver.compress({ files })

            logger.info(`[CodeBuilder#build] finished buildPath=${buildPath} duration=${Date.now() - startTime}ms`)

            return {
                success: true,
                archiveContent,
            }
        }
        catch (e) {
            logger.error(e, '[CodeBuilder#build]')
            return {
                success: false,
                error: e instanceof Error ? e.message : 'error building code',
            }
        }
        finally {
            await sandboxManager.returnSandbox(sandbox.boxId)
        }
    },
}

const downloadFiles = async (artifact: Buffer, buildPath: string) => {
    const tsConfigData = `{
        "extends": "@tsconfig/node18/tsconfig.json",
        "compilerOptions": {
            "strict": false
        }
    }`

    const tsConfigFilePath = `${buildPath}/tsconfig.json`
    await decompress(artifact, buildPath, {})
    await fs.writeFile(tsConfigFilePath, tsConfigData)
}

type BuildParams = {
    sourceArchiveContent: Buffer
}

type BuildSuccessOutput = {
    success: true
    archiveContent: Buffer
}

type BuildFailureOutput = {
    success: false
    error: string
}

type BuildOutput = BuildSuccessOutput | BuildFailureOutput

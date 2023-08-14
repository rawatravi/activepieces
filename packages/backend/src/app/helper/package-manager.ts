import { ExecOptions } from 'node:child_process'
import { exec } from './exec'
import { logger } from './logger'

const INSTALL_OPTIONS = [
    '--prefer-offline',
    '--config.lockfile=false',
    '--config.auto-install-peers=true',
] as const

const executePnpm = async (directory: string, command: PnpmCommand, ...args: string[]): Promise<PackageManagerOutput> => {
    const fullCommand = `npx pnpm ${command} ${args.join(' ')}`

    const execOptions: ExecOptions = {
        cwd: directory,
    }

    logger.info(`[PackageManager#executePnpm] directory: ${directory}, fullCommand: ${fullCommand}`)

    return await exec(fullCommand, execOptions)
}

export const packageManager = {
    async addDependencies(directory: string, dependencies: PackageManagerDependencies): Promise<PackageManagerOutput> {
        const depsCount = Object.keys(dependencies).length

        if (depsCount === 0) {
            logger.info('[PackageManager#addDependencies] skip adding deps, depsCount=0')
            return {
                stdout: '',
                stderr: '',
            }
        }

        const dependencyArgs = Object.entries(dependencies)
            .map(([name, meta]) => {
                return `${name}@${meta.version}`
            })

        return await executePnpm(directory, 'add', ...dependencyArgs, ...INSTALL_OPTIONS)
    },

    async initProject(directory: string): Promise<PackageManagerOutput> {
        return await executePnpm(directory, 'init')
    },

    async runLocalDependency(directory: string, command: PnpmDependencyCommand): Promise<PackageManagerOutput> {
        return await executePnpm(directory, command)
    },

    async linkDependency(directory: string, dependencyDirectory: string) {
        const result = await executePnpm(directory, 'link', dependencyDirectory)
        logger.info(`[PackageManager#linkDependency] result: ${JSON.stringify(result)} for directory: ${directory} and dependencyDirectory: ${dependencyDirectory}`)
    },

    async installDependencies({ directory }: InstallDependenciesParams): Promise<PackageManagerOutput> {
        return await executePnpm(directory, 'install', ...INSTALL_OPTIONS)
    },
}

type PackageManagerOutput = {
    stdout: string
    stderr: string
}

type PnpmCoreCommand = 'add' | 'init' | 'link' | 'install'
type PnpmDependencyCommand = 'tsc'
type PnpmCommand = PnpmCoreCommand | PnpmDependencyCommand

type InstallDependenciesParams = {
    directory: string
}

export type PackageMetadataInfo = {
    version: string
}

export type PackageInfo = PackageMetadataInfo & {
    name: string
}

export type PackageManagerDependencies = Record<string, PackageMetadataInfo>

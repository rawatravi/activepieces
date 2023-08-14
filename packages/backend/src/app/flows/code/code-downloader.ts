import { archiver } from '../../helper/archiver'
import { Sandbox } from '../../workers/sandbox'

export const codeDownloader = {
    /**
     * Downloads given packaged code archive to given sandbox.
     */
    async download({ archiveContent, archiveId, sandbox }: DownloadParams): Promise<void> {
        const sandboxPath = sandbox.getSandboxFolderPath()
        const outputPath = `${sandboxPath}/${archiveId}`

        await archiver.decompress({
            archiveContent,
            outputPath,
        })
    },
}

type DownloadParams = {
    archiveContent: Buffer
    archiveId: string
    sandbox: Sandbox
}

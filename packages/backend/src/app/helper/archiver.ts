import { writeFile, mkdir } from 'node:fs/promises'
import JsZip from 'jszip'

export const archiver = {
    async compress({ files }: CompressParams): Promise<Buffer> {
        const archive = new JsZip()
        files.forEach(file => archive.file(file.name, file.content))
        return await archive.generateAsync({ type: 'nodebuffer' })
    },

    async decompress({ archiveContent, outputPath }: DecompressParams): Promise<void> {
        const archive = await JsZip.loadAsync(archiveContent)

        await mkdir(outputPath, { recursive: true })

        const fileWriteJobs = Object.entries(archive.files).map(async ([name, file]) => {
            const content = await file.async('nodebuffer')
            await writeFile(`${outputPath}/${name}`, content)
        })

        await Promise.all(fileWriteJobs)
    },
}

type File = {
    name: string
    content: Buffer
}

type CompressParams = {
    files: File[]
}

type DecompressParams = {
    archiveContent: Buffer
    outputPath: string
}

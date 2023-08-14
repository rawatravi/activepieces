export const codeExecutor = {
   async executeCode({ directory, input }: ExecuteCodeParams): Promise<unknown> {
      const entrypoint = `./${directory}/index.js`;
      const codePieceModule: CodePieceModule = await import(entrypoint);
      return codePieceModule.code(input);
  }
}

type CodePieceModule = {
  code(params: unknown): Promise<unknown>;
}

type ExecuteCodeParams = {
  directory: string
  input: unknown
}

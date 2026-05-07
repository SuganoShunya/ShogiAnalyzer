declare module 'zshogi' {
  export const Engine: {
    init(): Promise<{
      run(command: string): string
    }>
  }
}

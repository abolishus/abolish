// The one snarkjs 0.7.5 entry point the prover calls; snarkjs ships no types.
declare module "snarkjs" {
  interface MemFile {
    readonly type: "mem";
    readonly data: Uint8Array;
  }
  interface Logger {
    debug(message: unknown): void;
    info(message: unknown): void;
    warn(message: unknown): void;
    error(message: unknown): void;
  }
  export const groth16: {
    fullProve(
      input: Readonly<Record<string, string | readonly string[]>>,
      wasm: MemFile,
      zkey: MemFile,
      logger: Logger,
      witnessOptions: undefined,
      proverOptions: { readonly singleThread: true },
    ): Promise<{ proof: unknown; publicSignals: unknown }>;
  };
}

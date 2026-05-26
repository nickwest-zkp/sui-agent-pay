declare module "@mysten/sui/cryptography" {
  export function decodeSuiPrivateKey(value: string): {
    scheme: string;
    secretKey: Uint8Array;
  };
}

declare module "@mysten/sui/grpc" {
  export class SuiGrpcClient {
    constructor(args: { network: string; baseUrl: string });
    getTransaction(args: {
      digest: string;
      include?: {
        balanceChanges?: boolean;
        effects?: boolean;
        events?: boolean;
      };
    }): Promise<unknown>;
  }
}

declare module "@mysten/sui/keypairs/ed25519" {
  type SuiKeypairLike = {
    toSuiAddress(): string;
    signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
    getSecretKey(): string;
  };

  export class Ed25519Keypair {
    static fromSecretKey(secretKey: Uint8Array): SuiKeypairLike;
    static generate(): SuiKeypairLike;
  }
}

declare module "@mysten/sui/keypairs/secp256k1" {
  type SuiKeypairLike = {
    toSuiAddress(): string;
    signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
    getSecretKey(): string;
  };

  export class Secp256k1Keypair {
    static fromSecretKey(secretKey: Uint8Array): SuiKeypairLike;
  }
}

declare module "@mysten/sui/keypairs/secp256r1" {
  type SuiKeypairLike = {
    toSuiAddress(): string;
    signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
    getSecretKey(): string;
  };

  export class Secp256r1Keypair {
    static fromSecretKey(secretKey: Uint8Array): SuiKeypairLike;
  }
}

declare module "@mysten/sui/transactions" {
  type TransactionObjectFactory = {
    clock(): unknown;
  } & ((value: string) => unknown);

  export class Transaction {
    constructor();
    gas: unknown;
    setSenderIfNotSet(sender: string): void;
    build(args?: unknown): Promise<Uint8Array>;
    moveCall(args: {
      target: string;
      typeArguments?: string[];
      arguments?: unknown[];
    }): unknown;
    splitCoins(coin: unknown, amounts: unknown[]): unknown[];
    mergeCoins(destination: unknown, sources: unknown[]): unknown;
    transferObjects(objects: unknown[], recipient: unknown): void;
    object: TransactionObjectFactory;
    pure: {
      u64(value: string): unknown;
      address(value: string): unknown;
      string(value: string): unknown;
      bool(value: boolean): unknown;
    };
  }
}

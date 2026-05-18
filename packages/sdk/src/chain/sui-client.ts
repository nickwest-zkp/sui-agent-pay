import {
  SUI_CLOCK_OBJECT_ID,
  SUI_NETWORKS,
  SUI_TYPE_ARG,
  type SuiAppConfig,
  type SuiCreateRegistryParams,
  type SuiCreateVaultParams,
  type SuiDepositParams,
  type SuiExecutePaymentParams,
  type SuiGiveFeedbackParams,
  type SuiRegisterAgentParams,
  type SuiRegisterSessionKeyParams,
  type SuiRevokeSessionKeyParams,
  type SuiSetPausedParams,
  type SuiTransactionExecutionResult,
  type SuiWithdrawParams,
} from "../sui-types";

interface SuiKeypairLike {
  toSuiAddress(): string;
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
}

interface SuiTransactionLike {
  setSenderIfNotSet(sender: string): void;
  build(args?: unknown): Promise<Uint8Array>;
  moveCall(args: {
    target: string;
    typeArguments?: string[];
    arguments?: unknown[];
  }): unknown;
  object(value: string): unknown;
  pure: {
    u64(value: string): unknown;
    address(value: string): unknown;
    string(value: string): unknown;
  };
}

interface SuiClientLike {
  core: {
    executeTransaction(args: {
      transaction: Uint8Array;
      signatures: string[];
      include: {
        transaction: boolean;
        effects: boolean;
        events: boolean;
      };
    }): Promise<unknown>;
  };
  getBalance(args: { owner: string; coinType: string }): Promise<unknown>;
  listCoins(args: { owner: string; coinType: string }): Promise<unknown>;
  getTransaction(args: {
    digest: string;
    include?: {
      balanceChanges?: boolean;
      effects?: boolean;
      events?: boolean;
      transaction?: boolean;
    };
  }): Promise<unknown>;
  getObject(args: {
    objectId: string;
    include?: {
      json?: boolean;
    };
  }): Promise<unknown>;
}

interface SuiRuntime {
  decodeSuiPrivateKey: (value: string) => {
    scheme: string;
    secretKey: Uint8Array;
  };
  Ed25519Keypair: {
    fromSecretKey(secretKey: Uint8Array): SuiKeypairLike;
  };
  Secp256k1Keypair: {
    fromSecretKey(secretKey: Uint8Array): SuiKeypairLike;
  };
  Secp256r1Keypair: {
    fromSecretKey(secretKey: Uint8Array): SuiKeypairLike;
  };
  SuiGrpcClient: new (args: { network: string; baseUrl: string }) => SuiClientLike;
  Transaction: new () => any;
}

let runtimePromise: Promise<SuiRuntime> | undefined;

async function loadSuiRuntime(): Promise<SuiRuntime> {
  runtimePromise ??= (async (): Promise<SuiRuntime> => {
    const [cryptography, grpc, ed25519, secp256k1, secp256r1, transactions] =
      await Promise.all([
        import("@mysten/sui/cryptography"),
        import("@mysten/sui/grpc"),
        import("@mysten/sui/keypairs/ed25519"),
        import("@mysten/sui/keypairs/secp256k1"),
        import("@mysten/sui/keypairs/secp256r1"),
        import("@mysten/sui/transactions"),
      ]);

    return {
      decodeSuiPrivateKey: cryptography.decodeSuiPrivateKey,
      Ed25519Keypair: ed25519.Ed25519Keypair,
      Secp256k1Keypair: secp256k1.Secp256k1Keypair,
      Secp256r1Keypair: secp256r1.Secp256r1Keypair,
      SuiGrpcClient: grpc.SuiGrpcClient,
      Transaction: transactions.Transaction,
    };
  })();

  return runtimePromise!;
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new Error("Sui private key hex must contain an even number of characters");
  }

  const result = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    result[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return result;
}

function toBigIntString(value: bigint | number | string): string {
  return BigInt(value).toString();
}

async function keypairFromHexSecretKey(secretKey: string): Promise<SuiKeypairLike> {
  const runtime = await loadSuiRuntime();
  const bytes = hexToBytes(secretKey);
  const normalized = bytes.length === 64 ? bytes.slice(0, 32) : bytes;
  return runtime.Ed25519Keypair.fromSecretKey(normalized);
}

async function keypairFromDecodedSecretKey(
  scheme: string,
  secretKey: Uint8Array
): Promise<SuiKeypairLike> {
  const runtime = await loadSuiRuntime();
  switch (scheme) {
    case "ED25519":
      return runtime.Ed25519Keypair.fromSecretKey(secretKey);
    case "Secp256k1":
      return runtime.Secp256k1Keypair.fromSecretKey(secretKey);
    case "Secp256r1":
      return runtime.Secp256r1Keypair.fromSecretKey(secretKey);
    default:
      throw new Error(`Unsupported Sui signature scheme: ${scheme}`);
  }
}

async function toKeypair(secretKey: string): Promise<SuiKeypairLike> {
  if (secretKey.startsWith("suiprivkey")) {
    const runtime = await loadSuiRuntime();
    const decoded = runtime.decodeSuiPrivateKey(secretKey);
    return keypairFromDecodedSecretKey(decoded.scheme, decoded.secretKey);
  }
  return keypairFromHexSecretKey(secretKey);
}

function extractDigest(rawResponse: unknown): string {
  if (!rawResponse || typeof rawResponse !== "object") {
    return "";
  }

  if ("Transaction" in rawResponse && rawResponse.Transaction && typeof (rawResponse as any).Transaction.digest === "string") {
    return (rawResponse as any).Transaction.digest;
  }

  if ("FailedTransaction" in rawResponse && rawResponse.FailedTransaction && typeof (rawResponse as any).FailedTransaction.digest === "string") {
    return (rawResponse as any).FailedTransaction.digest;
  }

  if ("digest" in rawResponse && typeof rawResponse.digest === "string") {
    return rawResponse.digest;
  }

  return "";
}

function stringifyExecutionError(error: unknown): string {
  if (!error) return "Transaction execution failed";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof (error as any).message === "string") {
    return (error as any).message;
  }
  return JSON.stringify(error);
}

function extractExecutionFailure(rawResponse: unknown): string | undefined {
  if (!rawResponse || typeof rawResponse !== "object") return undefined;

  if ("FailedTransaction" in rawResponse && (rawResponse as any).FailedTransaction) {
    const failed = (rawResponse as any).FailedTransaction;
    return stringifyExecutionError(failed.status?.error ?? failed.error ?? failed.status);
  }

  const tx = "Transaction" in rawResponse ? (rawResponse as any).Transaction : rawResponse;
  const status = (tx as any)?.status ?? (tx as any)?.effects?.status;
  if (!status) return undefined;

  if (typeof status === "object" && "$kind" in status && status.$kind !== "Success") {
    return stringifyExecutionError(status.error ?? status);
  }

  if (typeof status === "object" && "status" in status && status.status !== "success") {
    return stringifyExecutionError(status.error ?? status);
  }

  return undefined;
}

export class SuiChainClient {
  readonly config: SuiAppConfig;
  private readonly clientPromise: Promise<SuiClientLike>;

  constructor(config: SuiAppConfig) {
    this.config = config;
    const networkConfig = SUI_NETWORKS[config.network];
    this.clientPromise = loadSuiRuntime().then(({ SuiGrpcClient }) => new SuiGrpcClient({
      network: networkConfig.sdkNetwork,
      baseUrl: config.fullnodeUrl || networkConfig.grpcUrl,
    }));
  }

  private async getClient(): Promise<SuiClientLike> {
    return this.clientPromise;
  }

  private async executeTransaction(
    transaction: SuiTransactionLike,
    signerSecretKey: string
  ): Promise<SuiTransactionExecutionResult> {
    const [client, signer] = await Promise.all([
      this.getClient(),
      toKeypair(signerSecretKey),
    ]);
    transaction.setSenderIfNotSet(signer.toSuiAddress());

    const bytes = await transaction.build({ client });
    const { signature } = await signer.signTransaction(bytes);
    const rawResponse = await client.core.executeTransaction({
      transaction: bytes,
      signatures: [signature],
      include: {
        transaction: true,
        effects: true,
        events: true,
      },
    });
    const executionError = extractExecutionFailure(rawResponse);
    if (executionError) {
      throw new Error(executionError);
    }

    return {
      digest: extractDigest(rawResponse),
      signerAddress: signer.toSuiAddress(),
      rawResponse,
    };
  }

  private vaultTarget(functionName: string): string {
    return `${this.config.move.packageId}::${this.config.move.vaultModule}::${functionName}`;
  }

  private registryTarget(functionName: string): string {
    return `${this.config.move.packageId}::${this.config.move.registryModule}::${functionName}`;
  }

  async getBalance(owner: string, coinType: string = SUI_TYPE_ARG) {
    const client = await this.getClient();
    return client.getBalance({ owner, coinType });
  }

  async getCoins(owner: string, coinType: string = SUI_TYPE_ARG) {
    const client = await this.getClient();
    return client.listCoins({ owner, coinType });
  }

  async getTransaction(digest: string) {
    const client = await this.getClient();
    return client.getTransaction({
      digest,
      include: {
        balanceChanges: true,
        effects: true,
        events: true,
        transaction: true,
      },
    });
  }

  async getObject(objectId: string) {
    const client = await this.getClient();
    return client.getObject({
      objectId,
      include: {
        json: true,
      },
    });
  }

  async createVault(params: SuiCreateVaultParams): Promise<SuiTransactionExecutionResult> {
    const { Transaction } = await loadSuiRuntime();
    const tx = new Transaction();
    tx.moveCall({
      target: this.vaultTarget("create_vault"),
      typeArguments: [params.coinType ?? SUI_TYPE_ARG],
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async deposit(params: SuiDepositParams): Promise<SuiTransactionExecutionResult> {
    const { Transaction } = await loadSuiRuntime();
    const tx = new Transaction();
    tx.moveCall({
      target: this.vaultTarget("deposit"),
      typeArguments: [params.coinType ?? SUI_TYPE_ARG],
      arguments: [
        tx.object(params.vaultId),
        tx.object(params.coinObjectId),
      ],
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async withdraw(params: SuiWithdrawParams): Promise<SuiTransactionExecutionResult> {
    const [{ Transaction }, signer] = await Promise.all([
      loadSuiRuntime(),
      toKeypair(params.signerSecretKey),
    ]);
    const tx = new Transaction();
    tx.moveCall({
      target: this.vaultTarget("withdraw"),
      typeArguments: [params.coinType ?? SUI_TYPE_ARG],
      arguments: [
        tx.object(params.vaultId),
        tx.pure.u64(toBigIntString(params.amount)),
        tx.pure.address(params.recipient ?? signer.toSuiAddress()),
      ],
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async registerSessionKey(
    params: SuiRegisterSessionKeyParams
  ): Promise<SuiTransactionExecutionResult> {
    const { Transaction } = await loadSuiRuntime();
    const tx = new Transaction();
    tx.moveCall({
      target: this.vaultTarget("register_session_key"),
      typeArguments: [params.coinType ?? SUI_TYPE_ARG],
      arguments: [
        tx.object(params.vaultId),
        tx.pure.address(params.sessionKeyAddress),
        tx.pure.u64(toBigIntString(params.maxPerTx)),
        tx.pure.u64(toBigIntString(params.maxTotal)),
        tx.pure.u64(toBigIntString(params.expiryMs)),
        tx.pure.address(params.allowedRecipient ?? "0x0"),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async revokeSessionKey(
    params: SuiRevokeSessionKeyParams
  ): Promise<SuiTransactionExecutionResult> {
    const { Transaction } = await loadSuiRuntime();
    const tx = new Transaction();
    tx.moveCall({
      target: this.vaultTarget("revoke_session_key"),
      typeArguments: [params.coinType ?? SUI_TYPE_ARG],
      arguments: [
        tx.object(params.vaultId),
        tx.pure.address(params.sessionKeyAddress),
      ],
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async executePayment(
    params: SuiExecutePaymentParams
  ): Promise<SuiTransactionExecutionResult> {
    const { Transaction } = await loadSuiRuntime();
    const tx = new Transaction();
    tx.moveCall({
      target: this.vaultTarget("execute_payment"),
      typeArguments: [params.coinType ?? SUI_TYPE_ARG],
      arguments: [
        tx.object(params.vaultId),
        tx.object(SUI_CLOCK_OBJECT_ID),
        tx.pure.address(params.recipient),
        tx.pure.u64(toBigIntString(params.amount)),
      ],
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async setPaused(params: SuiSetPausedParams): Promise<SuiTransactionExecutionResult> {
    const { Transaction } = await loadSuiRuntime();
    const tx = new Transaction();
    tx.moveCall({
      target: this.vaultTarget(params.paused ? "pause" : "unpause"),
      typeArguments: [params.coinType ?? SUI_TYPE_ARG],
      arguments: [tx.object(params.vaultId)],
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async createRegistry(
    params: SuiCreateRegistryParams
  ): Promise<SuiTransactionExecutionResult> {
    const { Transaction } = await loadSuiRuntime();
    const tx = new Transaction();
    tx.moveCall({
      target: this.registryTarget("create_registry"),
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async registerAgent(
    params: SuiRegisterAgentParams
  ): Promise<SuiTransactionExecutionResult> {
    const [{ Transaction }, signer] = await Promise.all([
      loadSuiRuntime(),
      toKeypair(params.signerSecretKey),
    ]);
    const tx = new Transaction();
    tx.moveCall({
      target: this.registryTarget("register_agent"),
      arguments: [
        tx.object(params.registryId),
        tx.pure.string(params.agentUri),
        tx.pure.address(params.paymentAddress ?? signer.toSuiAddress()),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async giveFeedback(
    params: SuiGiveFeedbackParams
  ): Promise<SuiTransactionExecutionResult> {
    const { Transaction } = await loadSuiRuntime();
    const tx = new Transaction();
    tx.moveCall({
      target: this.registryTarget("give_feedback"),
      arguments: [
        tx.object(params.registryId),
        tx.pure.u64(toBigIntString(params.agentId)),
        tx.pure.u64(toBigIntString(params.score)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }
}

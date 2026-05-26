import {
  SUI_CLOCK_OBJECT_ID,
  SUI_NETWORKS,
  SUI_TYPE_ARG,
  type SuiAppConfig,
  type SuiCreateRegistryParams,
  type SuiCreateVaultParams,
  type SuiDepositParams,
  type SuiExecuteDeepBookSwapParams,
  type SuiExecutePaymentParams,
  type SuiExecuteMoveCallParams,
  type SuiGiveFeedbackParams,
  type SuiMoveCallArg,
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
  gas: unknown;
  moveCall(args: {
    target: string;
    typeArguments?: string[];
    arguments?: unknown[];
  }): unknown;
  splitCoins(coin: unknown, amounts: unknown[]): unknown[];
  mergeCoins(destination: unknown, sources: unknown[]): unknown;
  transferObjects(objects: unknown[], recipient: unknown): void;
  object(value: string): unknown;
  pure: {
    u64(value: string): unknown;
    address(value: string): unknown;
    string(value: string): unknown;
    bool(value: boolean): unknown;
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
  listBalances(args: { owner: string }): Promise<unknown>;
  listCoins(args: { owner: string; coinType?: string }): Promise<unknown>;
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
    fromSecretKey(secretKey: Uint8Array): any;
  };
  Secp256k1Keypair: {
    fromSecretKey(secretKey: Uint8Array): any;
  };
  Secp256r1Keypair: {
    fromSecretKey(secretKey: Uint8Array): any;
  };
  SuiGrpcClient: new (args: { network: string; baseUrl: string }) => any;
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

  async listBalances(owner: string) {
    const client = await this.getClient();
    return client.listBalances({ owner });
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

  private buildMoveCallArgument(tx: SuiTransactionLike, arg: SuiMoveCallArg, index: number): unknown {
    switch (arg.kind) {
      case "object":
        return tx.object(String(arg.value));
      case "address":
        return tx.pure.address(String(arg.value));
      case "u64":
        return tx.pure.u64(toBigIntString(arg.value as string));
      case "string":
        return tx.pure.string(String(arg.value));
      case "bool":
        if (typeof arg.value !== "boolean") {
          throw new Error(`Contract call argument ${index} must use a boolean value`);
        }
        return tx.pure.bool(arg.value);
      default:
        throw new Error(`Unsupported contract call argument kind: ${(arg as SuiMoveCallArg).kind}`);
    }
  }

  async executeMoveCall(
    params: SuiExecuteMoveCallParams
  ): Promise<SuiTransactionExecutionResult> {
    const { Transaction } = await loadSuiRuntime();
    const tx = new Transaction();
    tx.moveCall({
      target: `${params.packageId}::${params.module}::${params.functionName}`,
      typeArguments: params.typeArguments ?? [],
      arguments: (params.arguments ?? []).map((arg, index) => this.buildMoveCallArgument(tx, arg, index)),
    });
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async executeDeepBookSwap(
    params: SuiExecuteDeepBookSwapParams
  ): Promise<SuiTransactionExecutionResult> {
    if (params.inputCoinType !== SUI_TYPE_ARG) {
      throw new Error(`DeepBook demo currently supports only ${SUI_TYPE_ARG} as the input coin`);
    }

    const [{ Transaction }, signer] = await Promise.all([
      loadSuiRuntime(),
      toKeypair(params.signerSecretKey),
    ]);
    const tx = new Transaction() as SuiTransactionLike;
    const sender = signer.toSuiAddress();
    const [inputCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(toBigIntString(params.inputAmount))]);

    let currentCoin: unknown = inputCoin;
    const returnCoins: unknown[] = [];

    for (const hop of params.route) {
      const deepFeeCoin = tx.moveCall({
        target: "0x2::coin::zero",
        typeArguments: [params.deepCoinType],
      });

      if (hop.direction === "base_to_quote") {
        const [baseOut, quoteOut, deepOut] = tx.moveCall({
          target: `${params.packageId}::pool::swap_exact_base_for_quote`,
          typeArguments: [hop.baseCoinType, hop.quoteCoinType],
          arguments: [
            tx.object(hop.poolId),
            currentCoin,
            deepFeeCoin,
            tx.pure.u64(toBigIntString(hop.minOutputAmount)),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
        }) as [unknown, unknown, unknown];

        returnCoins.push(baseOut, deepOut);
        currentCoin = quoteOut;
      } else {
        const [baseOut, quoteOut, deepOut] = tx.moveCall({
          target: `${params.packageId}::pool::swap_exact_quote_for_base`,
          typeArguments: [hop.baseCoinType, hop.quoteCoinType],
          arguments: [
            tx.object(hop.poolId),
            currentCoin,
            deepFeeCoin,
            tx.pure.u64(toBigIntString(hop.minOutputAmount)),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
        }) as [unknown, unknown, unknown];

        returnCoins.push(quoteOut, deepOut);
        currentCoin = baseOut;
      }
    }

    tx.transferObjects([currentCoin, ...returnCoins], tx.pure.address(sender));
    return this.executeTransaction(tx, params.signerSecretKey);
  }

  async recoverOwnedCoins(params: {
    signerSecretKey: string;
    recipient: string;
    keepSuiGas?: bigint | number | string;
    coinTypes?: string[];
  }): Promise<{
    digest: string;
    signerAddress: string;
    rawResponse: unknown;
    recovered: Array<{
      coinType: string;
      balance: string;
      recoveredBalance: string;
    }>;
  }> {
    const [{ Transaction }, signer] = await Promise.all([
      loadSuiRuntime(),
      toKeypair(params.signerSecretKey),
    ]);

    const sender = signer.toSuiAddress();
    const [balancesResponse, suiBalanceResponse] = await Promise.all([
      this.listBalances(sender),
      this.getBalance(sender, SUI_TYPE_ARG),
    ]);

    const requestedTypes = new Set((params.coinTypes ?? []).map(value => value.toLowerCase()));
    const balanceEntries = Array.isArray((balancesResponse as any)?.balances)
      ? (balancesResponse as any).balances
      : [];
    const knownBalances = balanceEntries
      .map((entry: any): { coinType: string; balance: string } => ({
        coinType: String(entry?.coinType ?? ""),
        balance: String(entry?.coinBalance ?? entry?.balance ?? entry?.addressBalance ?? "0"),
      }))
      .filter((entry: { coinType: string; balance: string }) => entry.coinType && BigInt(entry.balance) > 0n)
      .filter((entry: { coinType: string; balance: string }) => requestedTypes.size === 0 || requestedTypes.has(entry.coinType.toLowerCase()));

    const tx = new Transaction() as SuiTransactionLike;
    const recovered: Array<{
      coinType: string;
      balance: string;
      recoveredBalance: string;
    }> = [];

    for (const entry of knownBalances.filter((item: { coinType: string; balance: string }) => item.coinType !== SUI_TYPE_ARG)) {
      const coinsResponse = await this.getCoins(sender, entry.coinType);
      const coinObjects = Array.isArray((coinsResponse as any)?.objects) ? (coinsResponse as any).objects : [];
      if (coinObjects.length === 0) {
        continue;
      }

      const primaryObjectId = String(coinObjects[0]?.objectId ?? "");
      if (!primaryObjectId) {
        continue;
      }

      if (coinObjects.length > 1) {
        tx.mergeCoins(
          tx.object(primaryObjectId),
          coinObjects
            .slice(1)
            .map((coin: any) => String(coin?.objectId ?? ""))
            .filter(Boolean)
            .map((objectId: string) => tx.object(objectId)),
        );
      }

      tx.transferObjects([tx.object(primaryObjectId)], tx.pure.address(params.recipient));
      recovered.push({
        coinType: entry.coinType,
        balance: entry.balance,
        recoveredBalance: entry.balance,
      });
    }

    const requestedSui =
      requestedTypes.size === 0 ||
      requestedTypes.has(SUI_TYPE_ARG.toLowerCase());
    if (requestedSui) {
      const rawSuiBalance =
        String(
          (suiBalanceResponse as any)?.balance?.coinBalance ??
          (suiBalanceResponse as any)?.balance?.balance ??
          (suiBalanceResponse as any)?.balance?.addressBalance ??
          (suiBalanceResponse as any)?.totalBalance ??
          "0",
        );
      const totalSui = BigInt(rawSuiBalance);
      const keepSuiGas = BigInt(params.keepSuiGas ?? 0);
      if (totalSui > keepSuiGas) {
        const recoverableSui = totalSui - keepSuiGas;
        const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(recoverableSui.toString())]);
        tx.transferObjects([suiCoin], tx.pure.address(params.recipient));
        recovered.push({
          coinType: SUI_TYPE_ARG,
          balance: totalSui.toString(),
          recoveredBalance: recoverableSui.toString(),
        });
      }
    }

    if (recovered.length === 0) {
      throw new Error("No recoverable assets found on the session key address");
    }

    const result = await this.executeTransaction(tx, params.signerSecretKey);
    return {
      ...result,
      recovered,
    };
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

interface SuiKeypairLike {
  toSuiAddress(): string;
  getSecretKey(): string;
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

async function toKeypair(secretKey: string): Promise<SuiKeypairLike> {
  const [cryptography, ed25519, secp256k1, secp256r1] = await Promise.all([
    import("@mysten/sui/cryptography"),
    import("@mysten/sui/keypairs/ed25519"),
    import("@mysten/sui/keypairs/secp256k1"),
    import("@mysten/sui/keypairs/secp256r1"),
  ]);

  if (secretKey.startsWith("suiprivkey")) {
    const decoded = cryptography.decodeSuiPrivateKey(secretKey);
    switch (decoded.scheme) {
      case "ED25519":
        return ed25519.Ed25519Keypair.fromSecretKey(decoded.secretKey);
      case "Secp256k1":
        return secp256k1.Secp256k1Keypair.fromSecretKey(decoded.secretKey);
      case "Secp256r1":
        return secp256r1.Secp256r1Keypair.fromSecretKey(decoded.secretKey);
      default:
        throw new Error(`Unsupported Sui signature scheme: ${decoded.scheme}`);
    }
  }

  const raw = hexToBytes(secretKey);
  const normalized = raw.length === 64 ? raw.slice(0, 32) : raw;
  return ed25519.Ed25519Keypair.fromSecretKey(normalized);
}

export async function generateSuiSessionKey(): Promise<{ secretKey: string; address: string }> {
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const keypair = Ed25519Keypair.generate();
  return {
    secretKey: keypair.getSecretKey(),
    address: keypair.toSuiAddress(),
  };
}

export async function resolveSuiAddress(secretKey: string): Promise<string> {
  const keypair = await toKeypair(secretKey);
  return keypair.toSuiAddress();
}

import _sodium from "libsodium-wrappers";

import * as Constants from "./Constants";

export const sodium = _sodium;
export const ready = _sodium.ready;

export function concatArrayBuffers(buffer1: Uint8Array, buffer2: Uint8Array): Uint8Array {
  const ret = new Uint8Array(buffer1.length + buffer2.length);
  ret.set(buffer1, 0);
  ret.set(buffer2, buffer1.length);
  return ret;
}

export function concatArrayBuffersArrays(buffers: Uint8Array[]): Uint8Array {
  const length = buffers.reduce((x, y) => x + y.length, 0);
  const ret = new Uint8Array(length);
  let pos = 0;
  for (const buffer of buffers) {
    ret.set(buffer, pos);
    pos += buffer.length;
  }
  return ret;
}

export function deriveKey(salt: Uint8Array, password: string): Uint8Array {
  salt = salt.subarray(0, sodium.crypto_pwhash_SALTBYTES);

  return sodium.crypto_pwhash(
    32,
    sodium.from_string(password),
    salt,
    sodium.crypto_pwhash_OPSLIMIT_SENSITIVE,
    sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    sodium.crypto_pwhash_ALG_DEFAULT
  );
}

export class CryptoManager {
  protected version: number;
  protected cipherKey: Uint8Array;
  protected macKey: Uint8Array;
  protected asymKeySeed: Uint8Array;

  constructor(key: Uint8Array, keyContext: string, version: number = Constants.CURRENT_VERSION) {
    keyContext = keyContext.padEnd(8);

    this.version = version;

    this.cipherKey = sodium.crypto_kdf_derive_from_key(32, 1, keyContext, key);
    this.macKey = sodium.crypto_kdf_derive_from_key(32, 2, keyContext, key);
    this.asymKeySeed = sodium.crypto_kdf_derive_from_key(32, 3, keyContext, key);
  }

  public encrypt(message: Uint8Array, additionalData: Uint8Array | null = null): Uint8Array {
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    return concatArrayBuffers(nonce,
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(message, additionalData, null, nonce, this.cipherKey));
  }

  public decrypt(nonceCiphertext: Uint8Array, additionalData: Uint8Array | null = null): Uint8Array {
    const nonceSize = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    const nonce = nonceCiphertext.subarray(0, nonceSize);
    const ciphertext = nonceCiphertext.subarray(nonceSize);
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, additionalData, nonce, this.cipherKey);
  }

  public encryptDetached(message: Uint8Array, additionalData: Uint8Array | null = null): [Uint8Array, Uint8Array] {
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ret = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt_detached(message, additionalData, null, nonce, this.cipherKey);
    return [ret.mac, concatArrayBuffers(nonce, ret.ciphertext)];
  }

  public decryptDetached(nonceCiphertext: Uint8Array, mac: Uint8Array, additionalData: Uint8Array | null = null): Uint8Array {
    const nonceSize = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    const nonce = nonceCiphertext.subarray(0, nonceSize);
    const ciphertext = nonceCiphertext.subarray(nonceSize);
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(null, ciphertext, mac, additionalData, nonce, this.cipherKey);
  }

  public getCryptoMac() {
    return new CryptoMac(this.macKey);
  }
}

export class AsymmetricCryptoManager {
  private keypair: _sodium.KeyPair;

  private constructor(keypair: _sodium.KeyPair) {
    this.keypair = keypair;
  }

  public static keygen(seed?: Uint8Array) {
    if (seed) {
      return new this(sodium.crypto_sign_seed_keypair(seed));
    } else {
      return new this(sodium.crypto_sign_keypair());
    }
  }

  public static fromPrivkey(privkey: Uint8Array) {
    return new this({
      keyType: "ed25519",
      privateKey: privkey,
      // The public key is embedded in the secret key and the function to extract it is not exposed in libsodium-wrappers.
      publicKey: privkey.subarray(sodium.crypto_sign_SEEDBYTES, sodium.crypto_sign_SEEDBYTES + sodium.crypto_sign_PUBLICKEYBYTES),
    });
  }

  public signDetached(message: Uint8Array): Uint8Array {
    return sodium.crypto_sign_detached(message, this.keypair.privateKey);
  }

  public static verifyDetached(message: Uint8Array, signature: Uint8Array, pubkey: Uint8Array): boolean {
    return sodium.crypto_sign_verify_detached(signature, message, pubkey);
  }

  public encryptSign(message: Uint8Array, pubkey: Uint8Array): Uint8Array {
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const sk = sodium.crypto_sign_ed25519_sk_to_curve25519(this.keypair.privateKey);
    const pk = sodium.crypto_sign_ed25519_pk_to_curve25519(pubkey);
    const ret = sodium.crypto_box_easy(message, nonce, pk, sk);

    return concatArrayBuffers(nonce, ret);
  }

  public decryptVerify(nonceCiphertext: Uint8Array, pubkey: Uint8Array): Uint8Array {
    const nonceSize = sodium.crypto_box_NONCEBYTES;
    const nonce = nonceCiphertext.subarray(0, nonceSize);
    const ciphertext = nonceCiphertext.subarray(nonceSize);

    const sk = sodium.crypto_sign_ed25519_sk_to_curve25519(this.keypair.privateKey);
    const pk = sodium.crypto_sign_ed25519_pk_to_curve25519(pubkey);

    return sodium.crypto_box_open_easy(ciphertext, nonce, pk, sk);
  }

  public get pubkey() {
    return this.keypair.publicKey;
  }

  public get privkey() {
    return this.keypair.privateKey;
  }
}

export class CryptoMac {
  private state: _sodium.StateAddress;
  private length: number;

  constructor(key: Uint8Array, length = 32) {
    this.length = length;
    this.state = sodium.crypto_generichash_init(key, length);
  }

  public update(messageChunk: Uint8Array) {
    sodium.crypto_generichash_update(this.state, messageChunk);
  }

  public finalize() {
    return sodium.crypto_generichash_final(this.state, this.length);
  }
}

export function getPrettyFingerprint(content: Uint8Array, delimiter = "   ") {
  const fingerprint = sodium.crypto_generichash(32, content);

  /* A 5 digit number can be stored in 16 bits, so a 256bit pubkey needs 16 5 digit numbers. */
  let ret = "";
  for (let i = 0 ; i < 32 ; i += 2) {
    const num = (fingerprint[i] << 8) + fingerprint[i + 1];
    const suffix = ((i + 2) % 8 === 0) ? "\n" : delimiter;
    ret += num.toString().padStart(5, "0") + suffix;
  }
  return ret;
}

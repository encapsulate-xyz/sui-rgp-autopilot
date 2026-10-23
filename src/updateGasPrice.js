const { SuiClient } = require("@mysten/sui.js/client");
const { TransactionBlock } = require("@mysten/sui.js/transactions");
const { Ed25519Keypair } = require("@mysten/sui.js/keypairs/ed25519");
const {
    PRIVATE_KEY_SIZE,
    SIGNATURE_SCHEME_TO_FLAG,
    SUI_PRIVATE_KEY_PREFIX,
    decodeSuiPrivateKey,
} = require("@mysten/sui.js/cryptography");
const { fromB64, SUI_SYSTEM_STATE_OBJECT_ID } = require("@mysten/sui.js/utils");

const updateGasPrice = async (
    network,
    rpc,
    privateKey,
    OpCapId,
    gasBudget,
    gasPrice
) => {
    try {
        const client = getClient(rpc);
        const signer = getSigner(privateKey);

        const tx = new TransactionBlock();
        tx.setGasBudget(parseInt(gasBudget));
        tx.moveCall({
            target: "0x3::sui_system::request_set_gas_price",
            arguments: [
                tx.object(SUI_SYSTEM_STATE_OBJECT_ID),
                tx.object(OpCapId),
                tx.pure.u64(gasPrice),
            ],
        });
        console.log("Updating gas price...");
        const result = await client.signAndExecuteTransactionBlock({
            signer,
            transactionBlock: tx,
            options: {
                showEffects: true,
                showEvents: true,
                showBalanceChanges: true,
            },
        });

        console.log(`Transaction Digest: https://suiscan.xyz/mainnet/tx/${result.effects.transactionDigest}`);
        console.log(`Status: ${JSON.stringify(result.effects.status)}`);
        if (result.effects.status.status === "success") {
            console.log("Gas price updated successfully.");
            return true;
        }
    } catch (e) {
        console.error("Error updating gas price:", e);
        return false;
    }
};

module.exports = {
    updateGasPrice,
};

function getClient(fullnode) {
    console.log("Getting client...");
    return new SuiClient({ url: fullnode });
}

function getSigner(privateKey) {
    console.log("Getting signer...");
    // Bech32 "suiprivkey1..." format
    if (privateKey.startsWith(SUI_PRIVATE_KEY_PREFIX)) {
        const { schema, secretKey } = decodeSuiPrivateKey(privateKey);
        if (schema !== "ED25519") {
            throw new Error("invalid key");
        }
        return Ed25519Keypair.fromSecretKey(secretKey);
    }

    // Legacy base64 format: flag byte + 32-byte secret key
    const raw = fromB64(privateKey);
    if (
        raw[0] !== SIGNATURE_SCHEME_TO_FLAG.ED25519 ||
        raw.length !== PRIVATE_KEY_SIZE + 1
    ) {
        throw new Error("invalid key");
    }

    return Ed25519Keypair.fromSecretKey(raw.slice(1));
}

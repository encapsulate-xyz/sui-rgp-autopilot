const {
    RawSigner,
    TransactionBlock,
    JsonRpcProvider,
    Connection,
    Ed25519Keypair,
    PRIVATE_KEY_SIZE,
    SIGNATURE_SCHEME_TO_FLAG,
    fromB64,
} = require("@mysten/sui.js");

const updateGasPrice = async (
    network,
    rpc,
    privateKey,
    OpCapId,
    gasBudget,
    gasPrice
) => {
    try {
        const provider = getProvider(rpc);
        const signer = getSigner(privateKey, provider);

        const tx = new TransactionBlock();
        tx.setGasBudget(parseInt(gasBudget));
        tx.moveCall({
            target: "0x3::sui_system::request_set_gas_price",
            arguments: [
                tx.pure("0x5"),
                tx.object(OpCapId),
                tx.pure(gasPrice),
            ],
        });
        console.log("Updating gas price...");
        const result = await signer.signAndExecuteTransactionBlock({
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

function getProvider(fullnode, faucet) {
    console.log("Getting provider...");
    const connection = new Connection({
        fullnode: fullnode,
        faucet: faucet,
    });
    return new JsonRpcProvider(connection);
}

function getSigner(privateKey, provider) {
    console.log("Getting signer...");
    const raw = fromB64(privateKey);
    if (
        raw[0] !== SIGNATURE_SCHEME_TO_FLAG.ED25519 ||
        raw.length !== PRIVATE_KEY_SIZE + 1
    ) {
        throw new Error("invalid key");
    }

    const keypair = Ed25519Keypair.fromSecretKey(raw.slice(1));
    return new RawSigner(keypair, provider);
}

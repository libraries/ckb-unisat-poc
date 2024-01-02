import { blockchain } from '@ckb-lumos/base';
import { bytes } from '@ckb-lumos/codec';
import { BI, DepType, Hash, HashType, RPC, Script, Transaction, config, helpers, utils } from '@ckb-lumos/lumos';
import { bech32, bech32m } from 'bech32';
import * as bitcoinjs from "bitcoinjs-lib";
import * as bs58 from 'bs58';


export const conf = {
    lumos: config.predefined.AGGRON4,
    url: 'https://testnet.ckb.dev',
    script: {
        auth: {
            codeHash: '0x55ef3361a3843cc82d91ad56a1fd125a8228933fa7ac2d52b861c80f224f2a79',
            hashType: 'data1' as HashType,
            cellCep: {
                outPoint: {
                    txHash: '0xb0f833d39195dc940daff51075431feddca76364dae1046629893a657336f752',
                    index: '0x0',
                },
                depType: 'code' as DepType,
            }
        },
        lock: {
            codeHash: '0x90c3e086a196dc89bcb85ab6ea9b7f92335ed45e90482663fef4248689c2adca',
            hashType: 'data1' as HashType,
            cellCep: {
                outPoint: {
                    txHash: '0x5119bb4e34628a9f709947ef0b7d7086d94f0f33e2f1e0ca66b24fda5304eab1',
                    index: '0x0',
                },
                depType: 'code' as DepType,
            }
        }
    },
}

export interface WalletUnisat {
    script: Script,
    addr: {
        ckb: string,
        btc: string,
    },
    sign(hash: Hash): Promise<Hash>,
}

export function walletUnisat(addr: string): WalletUnisat {
    let args = '0x04'
    if (addr.startsWith('bc1q')) {
        // NativeSegwit
        args += bytes.hexify(bech32.fromWords(bech32.decode(addr).words.slice(1))).slice(2)
    }
    if (addr.startsWith('3')) {
        // NestedSegwit
        args += bytes.hexify(bs58.decode(addr).slice(1, 21)).slice(2)
    }
    if (addr.startsWith('bc1p')) {
        // Taproot
        let xval = Buffer.from(bech32m.fromWords(bech32m.decode(addr).words.slice(1)))
        args += bitcoinjs.crypto.hash160(xval).toString('hex')
    }
    if (addr.startsWith('1')) {
        // Legacy
        args += bytes.hexify(bs58.decode(addr).slice(1, 21)).slice(2)
    }
    const script: Script = {
        codeHash: conf.script.lock.codeHash,
        hashType: conf.script.lock.hashType,
        args: args,
    }
    return {
        script: script,
        addr: {
            ckb: helpers.encodeToAddress(script, {
                config: conf.lumos,
            }),
            btc: addr,
        },
        sign: async (hash: Hash): Promise<Hash> => {
            async function readline(): Promise<string> {
                return new Promise((resolve, _) => {
                    process.stdin.resume();
                    process.stdin.on('data', function (data) {
                        process.stdin.pause();
                        resolve(data.toString());
                    })
                })
            }
            console.log(`run code in browser console:`)
            console.log(`  await unisat.signMessage('${hash.slice(2)}')`)
            console.log('copy signature from console:')
            let signBase64 = await readline()
            let sign = Buffer.from(signBase64, 'base64')
            if (addr.startsWith('bc1q')) {
                sign[0] = 39 + (sign[0] - 27) % 4
            }
            if (addr.startsWith('3')) {
                sign[0] = 35 + (sign[0] - 27) % 4
            }
            if (addr.startsWith('bc1p')) {
                sign[0] = 23 + (sign[0] - 27) % 4
            }
            if (addr.startsWith('1')) {
                sign[0] = 31 + (sign[0] - 27) % 4
            }
            return bytes.hexify(sign)
        },
    }
}

export async function walletUnisatCapacity(sender: WalletUnisat): Promise<BI> {
    const r = await new RPC(conf.url).getCellsCapacity({
        script: sender.script,
        scriptType: 'lock',
        filter: {
            scriptLenRange: ['0x0', '0x1']
        }
    })
    return BI.from(r.capacity)
}

export async function walletUnisatTransfer(
    sender: WalletUnisat,
    script: Script,
    capacity: BI,
) {
    let senderCapacity = BI.from(0)
    let acceptCapacity = capacity
    let acceptScript = script
    let changeCapacity = BI.from(0)
    let changeScript = sender.script
    let tx: Transaction = { version: '0x0', cellDeps: [], headerDeps: [], inputs: [], outputs: [], outputsData: [], witnesses: [] }
    tx.cellDeps.push({
        outPoint: { txHash: conf.lumos.SCRIPTS.SECP256K1_BLAKE160.TX_HASH, index: conf.lumos.SCRIPTS.SECP256K1_BLAKE160.INDEX },
        depType: conf.lumos.SCRIPTS.SECP256K1_BLAKE160.DEP_TYPE,
    })
    tx.cellDeps.push(conf.script.auth.cellCep)
    tx.cellDeps.push(conf.script.lock.cellCep)
    tx.outputs.push({ capacity: acceptCapacity.toHexString(), lock: acceptScript, type: undefined })
    tx.outputs.push({ capacity: changeCapacity.toHexString(), lock: changeScript, type: undefined })
    tx.outputsData.push('0x')
    tx.outputsData.push('0x')
    tx.witnesses.push(bytes.hexify(blockchain.WitnessArgs.pack({ lock: new Uint8Array(65), inputType: undefined, outputType: undefined })))
    const senderCellResult = await new RPC(conf.url).getCells({
        script: sender.script,
        scriptType: 'lock',
        filter: {
            scriptLenRange: ['0x0', '0x1']
        }
    }, 'asc', '0x100', undefined)
    const senderCell = senderCellResult['objects']
    for (const cell of senderCell) {
        const cellOutPoint = cell.outPoint
        const cellCapacity = BI.from(cell.output.capacity)
        const cellInput = { since: '0x0', previousOutput: cellOutPoint }
        senderCapacity = senderCapacity.add(cellCapacity)
        tx.inputs.push(cellInput)
        changeCapacity = senderCapacity.sub(acceptCapacity).sub(blockchain.Transaction.pack(tx).length + 4)
        if (changeCapacity.gte(BI.from(61).mul(100000000))) {
            break
        }
    }
    if (changeCapacity.lt(BI.from(61).mul(100000000))) {
        throw 'unreachable'
    }
    tx.outputs[1].capacity = changeCapacity.toHexString()
    let hasher = new utils.CKBHasher()
    hasher.update(bytes.bytify(utils.ckbHash(blockchain.RawTransaction.pack(tx))))
    for (let e of tx.witnesses) {
        let witness = bytes.bytify(e)
        let sizebuf = new Uint8Array(8)
        sizebuf[0] = Math.floor(witness.length % 256)
        sizebuf[1] = Math.floor(witness.length / 256)
        hasher.update(sizebuf)
        hasher.update(witness)
    }
    let txHash = hasher.digestHex()
    let txSign = await sender.sign(txHash)
    tx.witnesses[0] = bytes.hexify(blockchain.WitnessArgs.pack({ lock: txSign, inputType: undefined, outputType: undefined }))
    return await new RPC(conf.url).sendTransaction(tx, 'passthrough')
}

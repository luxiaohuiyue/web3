import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from "wagmi"
import style from "./mint.module.css"

const TEST_TOKEN_ABI = [
    {
        inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        name: 'mint',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
] as const

export function MintButton() {
    const { address: account, chain } = useAccount()
    const { writeContract, data: hash, isPending } = useWriteContract()

    // ✅ 1. 监听交易确认状态
    const { data: receipt, isSuccess: isTxSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash })
    const tagertAddress = '0x5A4eA3a013D42Cfd1B1609d19f6eA998EeE06D30'
    // '0x4798388e3adE569570Df626040F07DF71135C48E'
    // ✅ 2. 监听余额变化（交易确认后自动触发）
    const { data: balance } = useReadContract({
        address: tagertAddress,
        abi: TEST_TOKEN_ABI,
        functionName: 'balanceOf',
        args: [account],
        query: {
            enabled: !!account, // 仅在钱包连接时查询
        },
    })

    const handleMint = () => {
        if (!account || !chain) return
        writeContract({
            address: tagertAddress,
            abi: TEST_TOKEN_ABI,
            functionName: 'mint',
            args: [account, 1000000000000000000000n],
            account,
            chain,
        })
    }

    return (
        <div>
            <button
                className={style.buttonClass}
                onClick={handleMint}
                disabled={isPending || !account}
            >
                {isPending ? 'Minting...' : 'Mint 1000 TST'}
            </button>

            {/* ✅ 3. 根据交易状态显示反馈 */}
            {isTxSuccess && <p style={{color: 'green'}}>✅ Mint 成功！交易已确认</p>}
            {isTxError && <p style={{color: 'red'}}>❌ Mint 失败：{receipt?.status}</p>}

            {/* ✅ 4. 实时显示余额验证 */}
            {balance && <p>当前余额: {balance.toString()} TST</p>}
        </div>
    )
}
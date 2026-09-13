import { useState, useCallback } from 'react'
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits, formatUnits, encodePacked, type Address } from 'viem'
import { contractConfig, ERC20_ABI } from '@/lib/contracts'
import { TOKENS } from '@/lib/constants'

export interface SwapParams {
    tokenIn: string
    tokenOut: string
    amountIn: string
    slippage: number
    zeroForOne: boolean
    currentSqrtPriceX96: bigint // 👈 必须是 bigint 类型
}

export function useSwap() {
    const { address } = useAccount()
    const { writeContract, data: hash, isPending } = useWriteContract()
    const [lastSwapParams, setLastSwapParams] = useState<SwapParams | null>(null)

    // 等待交易确认
    const {
        isLoading: isConfirming,
        isSuccess: isConfirmed,
        isError: isTxError,
        error: txError,
        data: receipt,
    } = useWaitForTransactionReceipt({
        hash,
        confirmations: 2,
        timeout: 180_000,
    })

    const isTimeout = txError?.message?.includes('timeout') || false

    // 检查代币授权
    const useTokenAllowance = (tokenAddress: string) => {
        return useReadContract({
            address: tokenAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: address ? [address, contractConfig.swapRouter.address] : undefined,
            query: { enabled: Boolean(address && tokenAddress) },
        })
    }

    // 授权代币
    const approveToken = useCallback(async (tokenAddress: string, amount: string) => {
        if (!address) return
        const token = Object.values(TOKENS).find(t => t.address === tokenAddress)
        if (!token) throw new Error('Token not found')
        const amountWei = parseUnits(amount, token.decimals)
        writeContract({
            address: tokenAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [contractConfig.swapRouter.address, amountWei],
            gas: BigInt(500000),
        })
    }, [address, writeContract])

    // 获取价格预估
    const getQuote = useCallback(async (params: SwapParams) => {
        if (!params.amountIn || parseFloat(params.amountIn) === 0) return null
        try {
            let tokenInDecimals = 18;
            const tokenInObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === params.tokenIn.toLowerCase());
            if (tokenInObj) tokenInDecimals = tokenInObj.decimals;

            const amountInWei = parseUnits(params.amountIn, tokenInDecimals)
            const result = await fetch('/api/quote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tokenIn: params.tokenIn,
                    tokenOut: params.tokenOut,
                    amountIn: amountInWei.toString(),
                    indexPath: [0],
                    sqrtPriceLimitX96: '0',
                }),
            }).then(res => res.json())

            if (result.error) throw new Error(result.msg || result.error || '获取报价失败')

            let tokenOutDecimals = 18;
            const tokenOutObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === params.tokenOut.toLowerCase());
            if (tokenOutObj) tokenOutDecimals = tokenOutObj.decimals;

            const amountOut = BigInt(result.amountOut)
            return {
                amountOut: formatUnits(amountOut, tokenOutDecimals),
                priceImpact: result.priceImpact || '0.5',
                simulated: result.simulated || false,
            }
        } catch (error) {
            console.error('Quote failed:', error)
            throw error
        }
    }, [])

    // ==========================================
    // 👇 核心执行函数（已完美嵌入滑点计算逻辑）
    // ==========================================
    const executeSwap = useCallback(async (params: SwapParams) => {
        console.group('🔍 executeSwap Debug')

        // 1. 参数安检
        if (!params.currentSqrtPriceX96) {
            console.error("❌ 错误：当前池子价格未加载！");
            alert("价格数据加载中，请稍后再试！");
            return;
        }
        if (!address) {
            console.error('❌ 钱包未连接')
            return;
        }

        // 2. 获取代币信息
        const tokenIn = Object.values(TOKENS).find(t => t.address === params.tokenIn)
        const tokenOut = Object.values(TOKENS).find(t => t.address === params.tokenOut)
        if (!tokenIn || !tokenOut) {
            console.error('❌ 代币未找到')
            return;
        }

        const amountInWei = parseUnits(params.amountIn, tokenIn.decimals)

        // 3. 🌟 核心滑点计算逻辑（完美嵌入位置）
        const MIN_SQRT_PRICE = 4295128739n;
        const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
        const slippageBps = BigInt(Math.floor(params.slippage * 10000));
        const ONE_HUNDRED_PERCENT = 10000n;
        let finalLimit: bigint;

        if (params.zeroForOne) {
            let calculatedLimit = params.currentSqrtPriceX96 * (ONE_HUNDRED_PERCENT - slippageBps) / ONE_HUNDRED_PERCENT;
            finalLimit = calculatedLimit < MIN_SQRT_PRICE ? MIN_SQRT_PRICE : calculatedLimit;
        } else {
            let calculatedLimit = params.currentSqrtPriceX96 * (ONE_HUNDRED_PERCENT + slippageBps) / ONE_HUNDRED_PERCENT;
            finalLimit = calculatedLimit > MAX_SQRT_PRICE ? MAX_SQRT_PRICE : calculatedLimit;
        }
        console.log("✅ 传入合约的限制价格 (finalLimit):", finalLimit.toString());

        // 4. 处理代币包装和路径
        const isNativeTokenIn = 'isNative' in tokenIn && tokenIn.isNative
        const actualTokenIn = isNativeTokenIn && 'wrappedAddress' in tokenIn
            ? tokenIn.wrappedAddress as Address
            : params.tokenIn as Address

        const actualTokenOut = tokenOut.address === TOKENS.ETH.address && 'wrappedAddress' in TOKENS.ETH
            ? TOKENS.ETH.wrappedAddress as Address
            : params.tokenOut as Address

        const path = encodePacked(
            ['address', 'uint24', 'address'],
            [actualTokenIn, 1000, actualTokenOut]
        )

        // 5. 🌟 组装参数（把 finalLimit 传给合约）
        const swapParams = {
            path: path,
            tokenIn: actualTokenIn,
            tokenOut: actualTokenOut,
            indexPath: [0],
            recipient: address,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
            amountIn: amountInWei,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: finalLimit, // 👈 关键：传入计算好的限制价格
        }

        console.log('📦 swapParams:', swapParams)
        setLastSwapParams(params)

        // 6. 发起交易
        try {
            writeContract({
                ...contractConfig.swapRouter,
                functionName: 'exactInput',
                args: [swapParams],
                value: isNativeTokenIn ? amountInWei : BigInt(0),
                gas: BigInt(500000),
            })
            console.log('✅ writeContract 调用成功')
        } catch (error) {
            console.error('❌ writeContract 调用异常:', error)
            if (error?.message?.includes("SPL")) alert("滑点过低，请调高滑点！");
            else if (error?.message?.includes("Internal error")) alert("RPC 节点或钱包内部错误！");
        }
        console.groupEnd()
    }, [address, writeContract])

    return {
        executeSwap,
        approveToken,
        getQuote,
        useTokenAllowance,
        isPending,
        isConfirming,
        isConfirmed,
        isTxError,
        txError,
        hash,
        receipt,
        lastSwapParams,
        isTimeout,
        refetchReceipt: useCallback(() => {
            if (hash) console.log('手动重新检查交易状态:', hash)
        }, [hash]),
    }
}
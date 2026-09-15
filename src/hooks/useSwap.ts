import { useState, useCallback } from 'react'
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits, formatUnits, encodePacked, type Address } from 'viem'
import { contractConfig, ERC20_ABI } from '@/lib/contracts'
import { TOKENS } from '@/lib/constants'
// 定义 Uniswap V3 的价格边界常量
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/**
 * 根据当前价格和滑点容差，计算 sqrtPriceLimitX96
 * @param currentSqrtPriceX96 当前池子的 sqrtPriceX96 (bigint)
 * @param zeroForOne 交易方向 (true: Token0 -> Token1, false: Token1 -> Token0)
 * @param slippageBps 滑点容差，以基点 (Basis Points) 表示。例如 50 代表 0.5%，100 代表 1%
 */
export function calculateSqrtPriceLimit(
    currentSqrtPriceX96: bigint,
    zeroForOne: boolean,
    slippageBps: number
): bigint {
    // 1. 将滑点基点转换为乘数因子
    // 例如 50 bps = 0.5% = 0.005
    const slippageFactor = BigInt(slippageBps);
    const BPS_DENOMINATOR = 10000n;

    let limit: bigint;

    if (zeroForOne) {
        // 卖出 Token0，价格会【下降】
        // 计算下限：currentPrice * (1 - slippage)
        // 公式：currentSqrtPriceX96 * (10000 - slippageBps) / 10000
        limit = (currentSqrtPriceX96 * (BPS_DENOMINATOR - slippageFactor)) / BPS_DENOMINATOR;

        // 边界安全检查：不能低于全局最小价格
        if (limit < MIN_SQRT_RATIO) {
            limit = MIN_SQRT_RATIO;
        }
    } else {
        // 买入 Token0，价格会【上升】
        // 计算上限：currentPrice * (1 + slippage)
        // 公式：currentSqrtPriceX96 * (10000 + slippageBps) / 10000
        limit = (currentSqrtPriceX96 * (BPS_DENOMINATOR + slippageFactor)) / BPS_DENOMINATOR;

        // 边界安全检查：不能高于全局最大价格
        if (limit > MAX_SQRT_RATIO) {
            limit = MAX_SQRT_RATIO;
        }
    }

    return limit;
}
export interface SwapParams {
    tokenIn: string
    tokenOut: string
    amountIn: string
    slippage: number
    // zeroForOne: boolean
    // currentSqrtPriceX96: bigint // 👈 必须是 bigint 类型
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
            const tokenInObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === params.tokenIn?.toLowerCase());
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
        // if (!params.currentSqrtPriceX96) {
        //     console.error("❌ 错误：当前池子价格未加载！");
        //     alert("价格数据加载中，请稍后再试！");
        //     return;
        // }
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
        const currentSqrtPriceX96 = 1234567890123456789012345678n; // 示例价格

// 2. 设置滑点 (例如设置为 1%，即 100 bps)
        const SLIPPAGE_BPS = 100;

// 3. 确定交易方向
        const zeroForOne = tokenIn?.toLowerCase() < tokenOut?.toLowerCase();

// 4. 计算滑点保护限价
        const sqrtPriceLimitX96 = calculateSqrtPriceLimit(
            currentSqrtPriceX96,
            zeroForOne,
            SLIPPAGE_BPS
        );
        // 3. 🌟 核心滑点计算逻辑（完美嵌入位置）
        const MIN_SQRT_PRICE = 4295128739n;
        // const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
        const quote = await getQuote(params)
        if (!quote) throw new Error('获取报价失败')

        const quotedAmountOut = parseUnits(
            quote.amountOut,
            tokenOut.decimals
        )
        const slippageBps = BigInt(Math.round(params.slippage * 100))
        if (slippageBps < 0n || slippageBps >= 10_000n) {
            throw new Error('无效的滑点参数')
        }

        // const amountOutMinimum =
        //     quotedAmountOut * (10_000n - slippageBps) / 10_000n
        //
        // if (amountOutMinimum === 0n) {
        //     throw new Error('当前方向没有可用流动性')
        // }
        const ONE_HUNDRED_PERCENT = 10000n;
        // let finalLimit: bigint;

        // if (params.zeroForOne) {
        //     // let calculatedLimit = params.currentSqrtPriceX96 * (ONE_HUNDRED_PERCENT - slippageBps) / ONE_HUNDRED_PERCENT;
        //     finalLimit =  MIN_SQRT_PRICE +  1n ;
        // } else {
        //     // let calculatedLimit = params.currentSqrtPriceX96 * (ONE_HUNDRED_PERCENT + slippageBps) / ONE_HUNDRED_PERCENT;
        //     finalLimit =MIN_SQRT_PRICE - 1n ;
        // }
        // console.log("✅ 传入合约的限制价格 (finalLimit):", finalLimit.toString());
        const MIN_SQRT_RATIO  = 4295128739n
        const MAX_SQRT_PRICE =
            1461446703485210103287273052203988822378723970342n
        // 4. 处理代币包装和路径
        const isNativeTokenIn = 'isNative' in tokenIn && tokenIn.isNative
        const actualTokenIn = isNativeTokenIn && 'wrappedAddress' in tokenIn
            ? tokenIn.wrappedAddress as Address
            : params.tokenIn as Address

        const actualTokenOut = tokenOut.address === TOKENS.ETH.address && 'wrappedAddress' in TOKENS.ETH
            ? TOKENS.ETH.wrappedAddress as Address
            : params.tokenOut as Address
        // const zeroForOne =
        //     BigInt(actualTokenIn) < BigInt(actualTokenOut)
        //  finalLimit = zeroForOne
        //     ? MIN_SQRT_PRICE + 1n
        //     : MAX_SQRT_PRICE - 1n
        const path = encodePacked(
            ['address', 'uint24', 'address'],
            [actualTokenIn, 1000, actualTokenOut]
        )

        // 5. 🌟 组装参数（把 finalLimit 传给合约）
        const swapParams = {
            // path: path,
            // tokenIn: actualTokenIn,
            // tokenOut: actualTokenOut,
            // indexPath: [0],
            // recipient: address,
            // deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
            // amountIn: amountInWei,
            // amountOutMinimum,
            // sqrtPriceLimitX96: finalLimit, // 👈 关键：传入计算好的限制价格
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: 3000,
            recipient: address,
            deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20分钟过期
            amountIn: amountInWei,
            amountOutMinimum: 0n, // 注意：如果设置了 sqrtPriceLimitX96，这里可以设为 0，因为限价已经提供了保护
            sqrtPriceLimitX96: sqrtPriceLimitX96,
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
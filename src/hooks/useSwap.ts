import { useState, useCallback } from 'react'
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits, formatUnits, type Address } from 'viem'
import { contractConfig, ERC20_ABI } from '@/lib/contracts'
import { TOKENS } from '@/lib/constants'

export interface SwapParams {
    tokenIn: string
    tokenOut: string
    amountIn: string
    slippage: number
}

export function useSwap() {
    const { address } = useAccount()
    const { writeContract, data: hash, isPending } = useWriteContract()
    const [lastSwapParams, setLastSwapParams] = useState<SwapParams | null>(null)

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

    // ==========================================
    // 👇 优化后的获取价格预估逻辑
    // ==========================================
    const getQuote = useCallback(async (params: SwapParams) => {
        if (!params.amountIn || parseFloat(params.amountIn) === 0) return null
        try {
            // 1. 获取代币精度
            const tokenInObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === params.tokenIn?.toLowerCase());
            const tokenOutObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === params.tokenOut?.toLowerCase());

            const tokenInDecimals = tokenInObj?.decimals ?? 18;
            const tokenOutDecimals = tokenOutObj?.decimals ?? 18; // ✅ 修复：获取输出代币精度

            const amountInWei = parseUnits(params.amountIn, tokenInDecimals)

            // 2. 请求后端报价
            const response = await fetch('/api/quote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tokenIn: params.tokenIn,
                    tokenOut: params.tokenOut,
                    amountIn: amountInWei.toString(),
                    indexPath: [0],
                    poolIndex: 0,
                    sqrtPriceLimitX96: '0',
                }),
            });

            const responseText = await response.text()
            if (!responseText) throw new Error(`报价接口无响应，HTTP ${response.status}`)

            let result: {
                amountOut?: string
                poolAddress?: string
                poolIndex?: number
                error?: string
                msg?: string
            } // ✅ 移除对 sqrtPriceLimitX96 的依赖

            try {
                result = JSON.parse(responseText)
                console.log(result,'reererererrrrrrrrr')
            } catch {
                throw new Error(`报价接口返回了非 JSON 内容，HTTP ${response.status}`)
            }

            if (!response.ok || result.error) {
                throw new Error(result.msg || result.error || '获取报价失败')
            }

            // ✅ 优化：只校验后端实际返回的核心字段
            if (result.amountOut === undefined) {
                console.error('后端返回数据:', result); // 打印完整响应，方便排查
                throw new Error('报价接口缺少 amountOut 字段');
            }
            // if (result.poolIndex === undefined) {
            //     console.error('后端返回数据:', result);
            //     throw new Error('报价接口缺少 poolIndex 字段');
            // }

            const amountOutRaw = BigInt(result.amountOut)

            return {
                amountOutRaw,
                amountOut: formatUnits(amountOutRaw, tokenOutDecimals),
                poolAddress: result.poolAddress,
                poolIndex: 2
            }
        } catch (error) {
            console.error('Quote failed:', error)
            throw error
        }
    }, [])

    // ==========================================
    // 👇 核心执行函数（已修复未定义变量问题）
    // ==========================================
    const executeSwap = useCallback(async (params: SwapParams) => {
        console.group('🔍 executeSwap Debug')

        if (!address) {
            console.error('❌ 钱包未连接')
            return;
        }

        const tokenIn = Object.values(TOKENS).find(t => t.address === params.tokenIn)
        const tokenOut = Object.values(TOKENS).find(t => t.address === params.tokenOut)
        if (!tokenIn || !tokenOut) {
            console.error('❌ 代币未找到')
            return;
        }

        // 1. 获取报价
        const quote = await getQuote(params)
        if (!quote || quote.amountOutRaw <= 0n) {
            throw new Error('当前方向没有可成交流动性')
        }

        const amountInWei = parseUnits(params.amountIn, tokenIn.decimals)

        // 2. 计算滑点保护下限 (amountOutMinimum)
        const slippageBps = BigInt(Math.round(params.slippage * 100))
        if (slippageBps < 0n || slippageBps >= 10_000n) {
            throw new Error('无效的滑点参数')
        }
        const amountOutMinimum = quote.amountOutRaw * (10_000n - slippageBps) / 10_000n

        const tokenInAddress = typeof params.tokenIn === 'string'
            ? params.tokenIn
            : params.tokenIn.address;

        const tokenOutAddress = typeof params.tokenOut === 'string'
            ? params.tokenOut
            : params.tokenOut.address;

// 确认是字符串后再安全调用
        const zeroForOne =
            tokenInAddress.toLowerCase() < tokenOutAddress.toLowerCase()
        const MIN_SQRT_PRICE = 4295128739n
        const MAX_SQRT_PRICE =
            1461446703485210103287273052203988822378723970342n
        const sqrtPriceLimitX96 = zeroForOne
            ? MIN_SQRT_PRICE + 1n
            : MAX_SQRT_PRICE - 1n

        // 3. 处理原生代币
        const isNativeTokenIn = 'isNative' in tokenIn && tokenIn.isNative

        // 4. 组装交易参数
        const swapParams = {
            tokenIn: tokenIn.address as `0x${string}`,      // ✅ 修复：使用 tokenIn.address
            tokenOut: tokenOut.address as `0x${string}`,    // ✅ 修复：使用 tokenOut.address
            indexPath: [quote.poolIndex],
            recipient: address,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
            amountIn: amountInWei,
            amountOutMinimum,
            sqrtPriceLimitX96: sqrtPriceLimitX96, // ✅ 优化：设为 0n 表示不限制价格边界，完全依赖 amountOutMinimum 保护
        }

        console.log('📦 swapParams:', swapParams)
        setLastSwapParams(params)

        // 5. 发起交易
        try {
            writeContract({
                ...contractConfig.swapRouter,
                functionName: 'exactInput',
                args: [swapParams],
                value: isNativeTokenIn ? amountInWei : 0n,
                gas: 500000n,
            })
            console.log('✅ writeContract 调用成功')
        } catch (error: any) {
            console.error('❌ writeContract 调用异常:', error)
            if (error?.message?.includes("SPL")) alert("滑点过低，请调高滑点！");
            else if (error?.message?.includes("Internal error")) alert("RPC 节点或钱包内部错误！");
        }
        console.groupEnd()
    }, [address, writeContract, getQuote]) // ✅ 补全依赖数组

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
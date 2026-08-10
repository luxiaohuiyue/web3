import { useState, useCallback } from 'react'
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits, formatUnits ,encodePacked,type Address  } from 'viem'
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

  // 等待交易确认
  const { isLoading: isConfirming, isSuccess: isConfirmed ,
    isError: isTxError, error: txError,
    data: receipt, } = useWaitForTransactionReceipt({
    hash,
    // 明确指定需要的确认数（Sepolia 通常 1-2 个即可，主网建议 12 个）
    confirmations: 2,
    // 设置超时时间（例如 3 分钟），防止无限等待
    timeout: 180_000,
  })
  const isTimeout = txError?.message?.includes('timeout') || false

  // 提供一个手动刷新回执的函数（兜底方案）
  const refetchReceipt = useCallback(() => {
    if (hash) {
      // 触发 wagmi 内部的 refetch 逻辑
      // 注意：wagmi v2 的 useWaitForTransactionReceipt 没有直接暴露 refetch，
      // 但可以通过重新赋值 hash 或使用 publicClient 手动查询
      console.log('手动重新检查交易状态:', hash)
    }
  }, [hash])
  // 获取价格预估 - 使用合约调用
  const getQuote = useCallback(async (params: SwapParams) => {
    if (!params.amountIn || parseFloat(params.amountIn) === 0) {
      return null
    }

    try {
      // 找到对应的代币信息
      // Since we are fetching tokens from API now, the TOKENS constant might be outdated or incomplete if we rely solely on it.
      // However, for this hook, we receive token addresses.
      // We should ideally fetch token info if not found, but for fallback simulation we need decimals.
      
      // Let's try to find in TOKENS first, if not found, we might need to look up from a passed list or fetch.
      // But `useSwap` doesn't have access to the dynamic token list from `SwapInterface`.
      // The `params` only contain addresses.
      
      // FIX: In SwapInterface, we should pass decimals or full token objects to getQuote if possible, 
      // or useSwap should fetch token info on demand.
      // For now, let's relax the check for simulation fallback or assume standard 18 decimals if not found,
      // OR better: trust the API first.
      
      let tokenInDecimals = 18;
      const tokenInObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === params.tokenIn.toLowerCase());
      if (tokenInObj) tokenInDecimals = tokenInObj.decimals;
      
      // If we don't find it in TOKENS, we proceed with 18 decimals for API call serialization if needed,
      // but API call takes string amount. Wait, amountInWei needs decimals.
      // If we don't know decimals, we can't parse units correctly.
      
      // Solution: The caller (SwapInterface) knows the token objects. 
      // We should probably update useSwap to accept decimals or use public client to fetch decimals.
      // For immediate fix: assume 18 if not found, OR check if the caller can pass it.
      // `SwapParams` has strings.
      
      // Let's fetch decimals if not found in local map using wagmi's useReadContract? 
      // No, we can't use hooks inside callback.
      
      // We will assume 18 decimals if local lookup fails, but log a warning.
      if (!tokenInObj) {
         console.warn(`Token ${params.tokenIn} not found in local config, assuming 18 decimals`);
      }

      const amountInWei = parseUnits(params.amountIn, tokenInDecimals)
      
      // 调用合约的 quoteExactInput 函数
      const result = await fetch('/api/quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: amountInWei.toString(),
          indexPath: [0], // 简化：使用第一个池子的索引
          sqrtPriceLimitX96: '0',
        }),
      }).then(res => res.json())
      
      if (result.error) {
        // 抛出包含错误消息的错误，优先使用 msg 字段
        const errorMessage = result.msg || result.error || '获取报价失败'
        throw new Error(errorMessage)
      }
      
      // ... rest of the success logic
      
      let tokenOutDecimals = 18;
      const tokenOutObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === params.tokenOut.toLowerCase());
      if (tokenOutObj) tokenOutDecimals = tokenOutObj.decimals;
      
      const amountOut = BigInt(result.amountOut)
      const priceImpact = result.priceImpact || '0.5' // 默认价格影响
      console.log(result,'asasas')
      return {
        amountOut: formatUnits(amountOut, tokenOutDecimals),
        priceImpact,
        simulated: result.simulated || false,
      }
    } catch (error) {
      console.error('Quote failed:', error)
      // 不再回退到模拟数据，直接抛出错误
      throw error
    }
  }, [])

  // 检查代币授权
  const useTokenAllowance = (tokenAddress: string) => {
    return useReadContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: address ? [address, contractConfig.swapRouter.address] : undefined,
      query: {
        enabled: Boolean(address && tokenAddress),
      },
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
      args: [contractConfig.swapRouter.address, amountWei],gas:BigInt(500000),
    })
  }, [address, writeContract])

  // 执行交换
  // const executeSwap = useCallback(async (params: SwapParams) => {
  //   if (!address) {
  //     throw new Error('Wallet not connected')
  //   }
  //
  //   const tokenIn = Object.values(TOKENS).find(t => t.address === params.tokenIn)
  //   const tokenOut = Object.values(TOKENS).find(t => t.address === params.tokenOut)
  //
  //   if (!tokenIn || !tokenOut) {
  //     throw new Error('Token not found')
  //   }
  //
  //   const amountInWei = parseUnits(params.amountIn, tokenIn.decimals)
  //
  //   // 获取价格预估来计算最小输出
  //   const quote = await getQuote(params)
  //   if (!quote) {
  //     throw new Error('Failed to get quote')
  //   }
  //
  //   const amountOutWei = parseUnits(quote.amountOut, tokenOut.decimals)
  //   const minAmountOut = amountOutWei * BigInt(Math.floor((100 - params.slippage) * 100)) / BigInt(10000)
  //
  //   // 检查是否是原生ETH交易
  //   const isNativeTokenIn = 'isNative' in tokenIn && tokenIn.isNative
  //
  //   // 如果是ETH交易，则使用wrappedAddress(WETH)
  //   const actualTokenIn = isNativeTokenIn && 'wrappedAddress' in tokenIn
  //     ? tokenIn.wrappedAddress as string
  //     : params.tokenIn
  //
  //   const actualTokenOut = tokenOut.address === TOKENS.ETH.address && 'wrappedAddress' in TOKENS.ETH
  //     ? TOKENS.ETH.wrappedAddress as string
  //     : params.tokenOut
  //
  //   const swapParams = {
  //     tokenIn: actualTokenIn as `0x${string}`,
  //     tokenOut: actualTokenOut as `0x${string}`,
  //     indexPath: [0], // 简化：使用第一个池子的索引
  //     recipient: address,
  //     deadline: BigInt(Math.floor(Date.now() / 1000) + 1200), // 20分钟后过期
  //     amountIn: amountInWei,
  //     amountOutMinimum: minAmountOut,
  //     sqrtPriceLimitX96: BigInt(0),
  //   }
  //
  //   setLastSwapParams(params)
  //
  //   // 如果是ETH交易，增加value参数
  //   const value = isNativeTokenIn ? amountInWei : BigInt(0)
  //
  //   writeContract({
  //     ...contractConfig.swapRouter,
  //     functionName: 'exactInput',
  //     args: [swapParams],
  //     value,
  //   })
  // }, [address, writeContract, getQuote])
  const executeSwap = useCallback(async (params: SwapParams) => {
    console.group('🔍 executeSwap Debug')
    console.log('params:', params)
    console.log('address:', address)
    console.log('writeContract:', writeContract)
    console.log('contractConfig.swapRouter:', contractConfig.swapRouter)

    if (!address) {
      console.error('❌ 钱包未连接')
      throw new Error('Wallet not connected')
    }

    const tokenIn = Object.values(TOKENS).find(t => t.address === params.tokenIn)
    const tokenOut = Object.values(TOKENS).find(t => t.address === params.tokenOut)

    if (!tokenIn || !tokenOut) {
      console.error('❌ 代币未找到')
      throw new Error('Token not found')
    }

    const amountInWei = parseUnits(params.amountIn, tokenIn.decimals)
    const quote = await getQuote(params)
    if (!quote) {
      console.error('❌ 获取报价失败')
      throw new Error('Failed to get quote')
    }

    const amountOutWei = parseUnits(quote.amountOut, tokenOut.decimals)

    const slippageBps = BigInt(Math.floor(params.slippage * 100));
    const ONE_HUNDRED_PERCENT_BPS = 10000n;

// 安全的滑点计算公式
//     const minAmountOut = (amountOutWei * (ONE_HUNDRED_PERCENT_BPS - slippageBps)) / ONE_HUNDRED_PERCENT_BPS;
    // const slippageBps = BigInt(Math.fl oor(params.slippage * 100)); // 将 0.5 转为 50 (basis points)
    // const ONE_HUNDRED_PERCENT_BPS = BigInt(10000);
    const minAmountOut = 0n
// 计算公式：amountOut * (10000 - slippageBps) / 10000
//     const minAmountOut = (amountOutWei * (ONE_HUNDRED_PERCENT_BPS - slippageBps)) / ONE_HUNDRED_PERCENT_BPS;
//     const slippageBps = BigInt(Math.floor(params.slippage * 100))
    // const minAmountOut = amountOutWei - (amountOutWei * slippageBps / 10000n)
    // const minAmountOut = amountOutWei * BigInt(Math.floor((100 - params.slippage) * 100)) / BigInt(10000)

    const isNativeTokenIn = 'isNative' in tokenIn && tokenIn.isNative
    const actualTokenIn = isNativeTokenIn && 'wrappedAddress' in tokenIn
        ? tokenIn.wrappedAddress as Address
        : params.tokenIn

    const actualTokenOut = tokenOut.address === TOKENS.ETH.address && 'wrappedAddress' in TOKENS.ETH
        ? TOKENS.ETH.wrappedAddress as Address
        : params.tokenOut
    const path = encodePacked(
        ['address', 'uint24', 'address'],
        [actualTokenIn, 3000, actualTokenOut] // 3000 是 0.3% 的手续费
    )
    const swapParams = {
      path: path,
      tokenIn: actualTokenIn as `0x${string}`,
      tokenOut: actualTokenOut as `0x${string}`,
      indexPath: [0],
      recipient: address,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
      amountIn: amountInWei,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: BigInt(0),
    }
    console.log('swapParams:', swapParams)
    console.log('value:', isNativeTokenIn ? amountInWei : BigInt(0))
    console.log('ABI functionName:', contractConfig.swapRouter.abi.find(a => a.name === 'exactInput'))

    setLastSwapParams(params)

    try {
      writeContract({
        ...contractConfig.swapRouter,
        functionName: 'exactInput',
        args: [swapParams],
        value: isNativeTokenIn ? amountInWei : BigInt(0),gas:BigInt(500000),
      })
      console.log('✅ writeContract 调用成功')
    } catch (error) {
      console.error('❌ writeContract 调用异常:', error)
    }
    console.groupEnd()
  }, [address, writeContract, getQuote])

  return {
    executeSwap,
    approveToken,
    getQuote,
    useTokenAllowance,
    isPending,
    isConfirming,
    isConfirmed,
    isTxError,
    txError, // ✅ 新增：交易失败状态
    hash,
    receipt,        //
    lastSwapParams,
    isTimeout,        // 新增：是否超时
    refetchReceipt,
  }
} 
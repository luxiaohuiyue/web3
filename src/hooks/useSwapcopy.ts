import { useState, useCallback } from 'react'
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits, formatUnits ,encodePacked,type Address  } from 'viem'
import { contractConfig, ERC20_ABI, POOL_ABIS } from '@/lib/contracts'
import { TOKENS } from '@/lib/constants'

export interface SwapParams {
  tokenIn: string
  tokenOut: string
  amountIn: string
  slippage: number
  zeroForOne: boolean
  currentSqrtPriceX96: number
  sqrtPriceLimitX96: number
}
// const poolAddress = "0x8fE365424995B2415dc2c086a2D9D6c5feC3477a";


export function useSwap() {
  const { address } = useAccount()
  const { writeContract, data: hash, isPending } = useWriteContract()
  const [lastSwapParams, setLastSwapParams] = useState<SwapParams | null>(null)

// 提取 sqrtPriceX96（它是返回数组的第一个元素）
  const currentSqrtPriceX96 = '77351509797327908890733294413n';
  console.log("当前价格:", currentSqrtPriceX96)   ;
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

  const executeSwap = useCallback(async (params: SwapParams ,amountIn: bigint,
      zeroForOne: boolean,
      sqrtPriceLimitX96:bigint) => {
    console.group('🔍 executeSwap Debug')
    console.log('params:', params)
    console.log('address:', address)
    console.log('writeContract:', writeContract)
    console.log('zeroForOne',zeroForOne)
    console.log('contractConfig.swapRouter:', contractConfig.swapRouter)
    if (currentSqrtPriceX96 === undefined) {
      console.error("❌ 错误：当前池子价格未加载，请稍后再试！");
      alert("价格数据加载中，请稍后再试！");
      return; // 直接终止，不往下执行
    }

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



    const isNativeTokenIn = 'isNative' in tokenIn && tokenIn.isNative
    const actualTokenIn = isNativeTokenIn && 'wrappedAddress' in tokenIn
        ? tokenIn.wrappedAddress as Address
        : params.tokenIn

    const actualTokenOut = tokenOut.address === TOKENS.ETH.address && 'wrappedAddress' in TOKENS.ETH
        ? TOKENS.ETH.wrappedAddress as Address
        : params.tokenOut
    const path = encodePacked(
        ['address', 'uint24', 'address'],
        [actualTokenIn, 1000, actualTokenOut] // 3000 是 0.3% 的手续费
    )
    console.log('swapParams:', swapParams)
    console.log('value:', isNativeTokenIn ? amountInWei : BigInt(0))
    console.log('ABI functionName:', contractConfig.swapRouter.abi.find(a => a.name === 'exactInput'))
    console.log(sqrtPriceLimitX96,'sqrtPriceLimitX96')
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
      console.error("交易失败详情:", error);
      if (error?.message?.includes("SPL")) {
        alert("滑点过低，请调高滑点！");
      } else if (error?.message?.includes("Internal error")) {
        alert("RPC 节点或钱包内部错误，请检查网络或刷新页面！");
      }
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
    receipt,
    lastSwapParams,
    isTimeout,        // 新增：是否超时
    refetchReceipt,
  }
}
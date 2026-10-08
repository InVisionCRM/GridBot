// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Read-only token safety probe. NEVER deployed: the bot injects this runtime code at a throwaway address via
 * an eth_call state override (with a fake native balance) and calls probe(). Nothing is sent on-chain.
 *
 * Flow: wrap native → [optional prep hop WETH→quote] → BUY token (quoted vs received) → transfer 10% to a
 * fresh address (sent vs received) → SELL the rest back (quoted vs received). Balance deltas reveal buy /
 * transfer / sell taxes; a revert at a stage reveals a honeypot (cannot sell) or a blocked transfer.
 * V2 hops use the router's *SupportingFeeOnTransferTokens method so taxed tokens are measured, not just reverted.
 */
contract SafetyProbe {
    struct Hop { uint8 kind; address router; address quoter; uint24 fee; address tokenIn; address tokenOut; }

    struct Result {
        uint256 quoteIn;
        uint256 expectedBuy;
        uint256 gotBuy;
        uint256 transferSent;
        uint256 transferGot;
        uint256 sellIn;
        uint256 expectedSell;
        uint256 gotSell;
        uint8 stage; // 0 ok · 1 prep failed · 2 buy failed · 3 transfer failed · 4 sell failed
        bytes err;
        uint256 gasBuy;
        uint256 gasSell;
    }

    function probe(address weth, uint256 wethIn, Hop calldata prep, bool hasPrep, Hop calldata buy, Hop calldata sell)
        external returns (Result memory r)
    {
        (bool okDep, ) = weth.call{value: wethIn}(abi.encodeWithSignature("deposit()"));
        require(okDep, "deposit failed");
        uint256 amt = wethIn;
        if (hasPrep) {
            try this.swapExt(prep, amt) returns (uint256 got) { amt = got; } catch (bytes memory e) { r.stage = 1; r.err = e; return r; }
        }
        r.quoteIn = amt;
        r.expectedBuy = _quote(buy, amt);
        uint256 g = gasleft();
        try this.swapExt(buy, amt) returns (uint256 got) { r.gotBuy = got; } catch (bytes memory e) { r.stage = 2; r.err = e; return r; }
        r.gasBuy = g - gasleft();

        uint256 t = r.gotBuy / 10;
        if (t > 0) {
            address sink = address(uint160(uint256(keccak256("safety-probe-sink"))));
            uint256 s0 = _bal(buy.tokenOut, sink);
            (bool okT, bytes memory d) = buy.tokenOut.call(abi.encodeWithSignature("transfer(address,uint256)", sink, t));
            if (!okT || (d.length >= 32 && !abi.decode(d, (bool)))) { r.stage = 3; r.err = d; return r; }
            r.transferSent = t;
            r.transferGot = _bal(buy.tokenOut, sink) - s0;
        }

        r.sellIn = _bal(sell.tokenIn, address(this));
        r.expectedSell = _quote(sell, r.sellIn);
        g = gasleft();
        try this.swapExt(sell, r.sellIn) returns (uint256 got) { r.gotSell = got; } catch (bytes memory e) { r.stage = 4; r.err = e; return r; }
        r.gasSell = g - gasleft();
    }

    function swapExt(Hop calldata h, uint256 amountIn) external returns (uint256 got) {
        require(msg.sender == address(this), "self only");
        h.tokenIn.call(abi.encodeWithSignature("approve(address,uint256)", h.router, amountIn));
        uint256 b0 = _bal(h.tokenOut, address(this));
        bool ok;
        bytes memory d;
        if (h.kind == 0) {
            address[] memory path = new address[](2);
            path[0] = h.tokenIn;
            path[1] = h.tokenOut;
            (ok, d) = h.router.call(abi.encodeWithSignature(
                "swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
                amountIn, 0, path, address(this), block.timestamp + 600));
        } else {
            // SwapRouter02 / PancakeSwap SmartRouter: exactInputSingle((tokenIn,tokenOut,fee,recipient,amountIn,amountOutMinimum,sqrtPriceLimitX96))
            (ok, d) = h.router.call(abi.encodeWithSelector(0x04e45aaf, h.tokenIn, h.tokenOut, h.fee, address(this), amountIn, uint256(0), uint256(0)));
        }
        if (!ok) assembly { revert(add(d, 32), mload(d)) }
        got = _bal(h.tokenOut, address(this)) - b0;
    }

    function _quote(Hop calldata h, uint256 amountIn) internal returns (uint256) {
        bool ok;
        bytes memory d;
        if (h.kind == 0) {
            address[] memory path = new address[](2);
            path[0] = h.tokenIn;
            path[1] = h.tokenOut;
            (ok, d) = h.router.staticcall(abi.encodeWithSignature("getAmountsOut(uint256,address[])", amountIn, path));
            if (!ok || d.length < 128) return 0;
            uint256[] memory a = abi.decode(d, (uint256[]));
            return a[a.length - 1];
        }
        // QuoterV2.quoteExactInputSingle((tokenIn,tokenOut,amountIn,fee,sqrtPriceLimitX96))
        (ok, d) = h.quoter.call(abi.encodeWithSelector(0xc6a5026a, h.tokenIn, h.tokenOut, amountIn, h.fee, uint256(0)));
        if (!ok || d.length < 32) return 0;
        return abi.decode(d, (uint256));
    }

    function _bal(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory d) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && d.length >= 32 ? abi.decode(d, (uint256)) : 0;
    }

    receive() external payable {}
}

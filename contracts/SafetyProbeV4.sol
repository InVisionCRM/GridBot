// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Read-only V4 token safety probe. NEVER deployed: the bot injects this runtime code at a throwaway address via
 * an eth_call state override (with a fake native balance) and calls probe(). Nothing is sent on-chain.
 *
 * Flow: [wrap native → optional V2/V3 prep hop] → BUY through the exact V4 PoolKey and hooks (Universal Router +
 * Permit2) → transfer 10% to a fresh address → SELL the rest back the same way. Balance deltas reveal buy /
 * transfer / sell taxes; a revert at a stage reveals a honeypot. Native currency is address(0): the probe sends
 * value and measures its own ETH balance. The sell of native ETH quotes and swaps only the bought remainder
 * (gotBuy minus the 10% transfer), not the funding ETH the state override endowed. V2 prep hops use
 * SupportingFeeOnTransferTokens, same as SafetyProbe.
 *
 * The V4 hop encodes Universal Router 2.1.x calldata: command 0x10, actions 0x06/0x0c/0x0f, and
 * ExactInputSingleParams with minHopPriceX36 = 0.
 */
contract SafetyProbeV4 {
    struct Hop { uint8 kind; address router; address quoter; uint24 fee; address tokenIn; address tokenOut; }

    struct Key { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }

    struct V4Leg { Key key; bool zeroForOne; address quoter; address router; address permit2; }

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

    function probe(address weth, uint256 wethIn, Hop calldata prep, bool hasPrep, V4Leg calldata buy, V4Leg calldata sell)
        external returns (Result memory r)
    {
        address inCur = buy.zeroForOne ? buy.key.currency0 : buy.key.currency1;
        uint256 amt;
        if (inCur == address(0) && !hasPrep) {
            amt = wethIn;
        } else {
            (bool okDep, ) = weth.call{value: wethIn}(abi.encodeWithSignature("deposit()"));
            require(okDep, "deposit failed");
            amt = wethIn;
            if (hasPrep) {
                try this.swapExt(prep, amt) returns (uint256 got) { amt = got; }
                catch (bytes memory e) { r.stage = 1; r.err = e; return r; }
            }
        }
        r.quoteIn = amt;
        r.expectedBuy = _quoteV4(buy, amt);
        uint256 g = gasleft();
        try this.swapV4(buy, amt) returns (uint256 got) { r.gotBuy = got; }
        catch (bytes memory e) { r.stage = 2; r.err = e; return r; }
        r.gasBuy = g - gasleft();

        address bought = buy.zeroForOne ? buy.key.currency1 : buy.key.currency0;
        uint256 t = r.gotBuy / 10;
        if (t > 0) {
            address sink = address(uint160(uint256(keccak256("safety-probe-sink"))));
            uint256 s0 = _bal(bought, sink);
            bool moved;
            bytes memory d;
            if (bought == address(0)) {
                (moved, d) = sink.call{value: t}("");
            } else {
                (moved, d) = bought.call(abi.encodeWithSignature("transfer(address,uint256)", sink, t));
                if (moved && d.length >= 32 && !abi.decode(d, (bool))) moved = false;
            }
            if (!moved) { r.stage = 3; r.err = d; return r; }
            r.transferSent = t;
            r.transferGot = _bal(bought, sink) - s0;
        }

        address sellCur = sell.zeroForOne ? sell.key.currency0 : sell.key.currency1;
        // ERC-20: the probe held none of the bought token, so its balance is what remains after the 10%
        // transfer — the same sell size as SafetyProbe. Native ETH is also the funding endowment, so the
        // balance includes leftover ETH. Quote and sell only the bought remainder.
        if (sellCur == address(0)) r.sellIn = bought == address(0) ? r.gotBuy - r.transferSent : 0;
        else r.sellIn = _bal(sellCur, address(this));
        r.expectedSell = _quoteV4(sell, r.sellIn);
        g = gasleft();
        try this.swapV4(sell, r.sellIn) returns (uint256 got) { r.gotSell = got; }
        catch (bytes memory e) { r.stage = 4; r.err = e; return r; }
        r.gasSell = g - gasleft();
    }

    /// V2/V3 prep hop. Identical routing to SafetyProbe.swapExt (kind 0 fee-on-transfer, kind 1 exactInputSingle).
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
            (ok, d) = h.router.call(abi.encodeWithSelector(0x04e45aaf, h.tokenIn, h.tokenOut, h.fee, address(this), amountIn, uint256(0), uint256(0)));
        }
        if (!ok) assembly { revert(add(d, 32), mload(d)) }
        got = _bal(h.tokenOut, address(this)) - b0;
    }

    /// One V4 exact-in hop through the Universal Router, using the leg's PoolKey and hooks unchanged.
    function swapV4(V4Leg calldata leg, uint256 amountIn) external returns (uint256 got) {
        require(msg.sender == address(this), "self only");
        address tokenIn = leg.zeroForOne ? leg.key.currency0 : leg.key.currency1;
        address tokenOut = leg.zeroForOne ? leg.key.currency1 : leg.key.currency0;
        if (tokenIn != address(0)) {
            tokenIn.call(abi.encodeWithSignature("approve(address,uint256)", leg.permit2, amountIn));
            (bool okP, bytes memory dp) = leg.permit2.call(
                abi.encodeWithSignature("approve(address,address,uint160,uint48)", tokenIn, leg.router, uint160(amountIn), uint48(block.timestamp + 600))
            );
            if (!okP) assembly { revert(add(dp, 32), mload(dp)) }
        }
        uint256 b0 = _bal(tokenOut, address(this));
        bytes memory actions = hex"060c0f";
        bytes memory p0 = abi.encode(leg.key, leg.zeroForOne, uint128(amountIn), uint128(0), uint256(0), bytes(""));
        bytes memory p1 = abi.encode(tokenIn, amountIn);
        bytes memory p2 = abi.encode(tokenOut, uint256(0));
        bytes[] memory params = new bytes[](3);
        params[0] = p0;
        params[1] = p1;
        params[2] = p2;
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        uint256 value = tokenIn == address(0) ? amountIn : 0;
        (bool ok, bytes memory d) = leg.router.call{value: value}(
            abi.encodeWithSignature("execute(bytes,bytes[],uint256)", bytes(hex"10"), inputs, block.timestamp + 600)
        );
        if (!ok) assembly { revert(add(d, 32), mload(d)) }
        got = _bal(tokenOut, address(this)) - b0;
    }

    function _quoteV4(V4Leg calldata leg, uint256 amountIn) internal returns (uint256) {
        if (amountIn == 0 || amountIn > type(uint128).max) return 0;
        try this.quoteV4Ext(leg, uint128(amountIn)) returns (uint256 out) { return out; }
        catch { return 0; }
    }

    /// External so a quoter revert (it is not a view) cannot abort the probe; a failed quote is 0.
    function quoteV4Ext(V4Leg calldata leg, uint128 amountIn) external returns (uint256 out) {
        require(msg.sender == address(this), "self only");
        (bool ok, bytes memory d) = leg.quoter.call(
            abi.encodeWithSignature(
                "quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))",
                leg.key, leg.zeroForOne, amountIn, bytes("")
            )
        );
        if (!ok || d.length < 32) return 0;
        (out, ) = abi.decode(d, (uint256, uint256));
    }

    function _bal(address token, address who) internal view returns (uint256) {
        if (token == address(0)) return who.balance;
        (bool ok, bytes memory d) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && d.length >= 32 ? abi.decode(d, (uint256)) : 0;
    }

    receive() external payable {}
}

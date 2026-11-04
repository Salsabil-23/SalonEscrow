// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SafeERC20Probe — contrat de TEST uniquement (jamais déployé sur un testnet)
/// @notice Reproduit ce que fera DepositVault : prendre des jetons avec safeTransferFrom (après approve du client)
///         et les renvoyer avec safeTransfer. Sert à prouver que MockTND est compatible SafeERC20.
contract SafeERC20Probe {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    constructor(IERC20 token_) {
        token = token_;
    }

    function pull(address from, uint256 amount) external {
        token.safeTransferFrom(from, address(this), amount);
    }

    function push(address to, uint256 amount) external {
        token.safeTransfer(to, amount);
    }
}

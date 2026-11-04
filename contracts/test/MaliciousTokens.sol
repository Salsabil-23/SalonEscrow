// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Jetons HOSTILES pour tester les défenses de DepositVault. TEST UNIQUEMENT.
// MockTND est un ERC-20 standard : il ne peut ni rappeler le coffre, ni renvoyer `false`.
// Ces jetons simulent le pire cas pour montrer que ReentrancyGuard et SafeERC20 font leur travail.

interface ITokenReceiver {
    function onTokenReceived(address from, uint256 amount) external;
}

/// @notice Jeton qui prévient le destinataire choisi à chaque réception (comme un ERC-777) : permet une réentrance.
contract HookToken is ERC20 {
    address public hookTarget;

    constructor() ERC20("HookToken", "HOOK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHookTarget(address target) external {
        hookTarget = target;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == hookTarget && to != address(0)) ITokenReceiver(to).onTokenReceived(from, value);
    }
}

/// @notice Jeton non conforme qui renvoie `false` au lieu d'échouer quand `failTransfers` est activé.
contract FalseReturningToken is ERC20 {
    bool public failTransfers;

    constructor() ERC20("FalseToken", "FALSE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFailTransfers(bool fail) external {
        failTransfers = fail;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (failTransfers) return false;
        return super.transfer(to, value);
    }
}

interface IVaultHarness {
    function book(uint256 bookingId, uint32 centerId) external returns (uint256);
    function withdraw() external;
}

/// @notice Client malveillant : quand le coffre lui envoie ses jetons, il tente de rappeler `withdraw`.
contract ReentrantWithdrawer is ITokenReceiver {
    IVaultHarness public immutable vault;
    HookToken public immutable token;

    constructor(IVaultHarness vault_, HookToken token_) {
        vault = vault_;
        token = token_;
    }

    function book(uint256 bookingId, uint32 centerId) external {
        token.approve(address(vault), type(uint256).max);
        vault.book(bookingId, centerId);
    }

    function attack() external {
        vault.withdraw();
    }

    function onTokenReceived(address, uint256) external override {
        if (msg.sender == address(token)) vault.withdraw();
    }
}

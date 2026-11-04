// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockTND — jeton ERC-20 de TEST pour SalonEscrow (aucune valeur réelle)
/// @notice Représente le dinar tunisien avec 6 décimales : 1 TND = 1 000 000 unités, 30 TND = 30 000 000.
///         N'importe qui peut obtenir des jetons avec `faucet`, au plus 1 000 TND par appel.
/// @dev    Hérite de l'ERC-20 standard d'OpenZeppelin 5.0.2 sans le modifier : `approve`, `transferFrom`,
///         `allowance` et les retours booléens sont ceux de la norme, donc compatibles avec SafeERC20.
///         À ne JAMAIS déployer sur un réseau principal : la création de jetons est ouverte à tous.
contract MockTND is ERC20 {
    /// @notice Nombre de décimales du jeton (comme l'USDC), au lieu des 18 par défaut.
    uint8 private constant DECIMALS = 6;

    /// @notice Plafond d'un appel au faucet : 1 000 TND = 1 000 × 10^6 unités.
    uint256 public constant MAX_FAUCET_AMOUNT = 1_000 * 10 ** DECIMALS;

    /// @notice Montant demandé nul.
    error FaucetZeroAmount();
    /// @notice Montant demandé supérieur au plafond par appel.
    error FaucetAmountTooHigh(uint256 requested, uint256 maximum);

    constructor() ERC20("MockTND", "MockTND") {}

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Crée `amount` unités (6 décimales) et les envoie à l'appelant.
    /// @param amount Montant en plus petite unité, entre 1 et MAX_FAUCET_AMOUNT inclus.
    /// @dev    Le plafond est par appel, comme le prévoit le cahier des charges : il limite les erreurs de saisie
    ///         (ex. oublier que 30 TND = 30 000 000), pas un abus volontaire, ce qui est acceptable pour un jeton de test.
    ///         `_mint` émet l'événement standard Transfer(address(0), appelant, amount).
    function faucet(uint256 amount) external {
        if (amount == 0) revert FaucetZeroAmount();
        if (amount > MAX_FAUCET_AMOUNT) revert FaucetAmountTooHigh(amount, MAX_FAUCET_AMOUNT);
        _mint(msg.sender, amount);
    }
}

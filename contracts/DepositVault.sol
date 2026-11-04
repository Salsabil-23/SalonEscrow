// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CenterAccess} from "./CenterAccess.sol";
import {EscrowHooks} from "./EscrowHooks.sol";

/// @title DepositVault — l'argent de SalonEscrow (Membre 2, Module 6)
/// @notice Bloque l'acompte d'une réservation, applique la règle des 24 heures, crédite des soldes
///         et laisse chaque bénéficiaire retirer SON solde lui-même (`withdraw`).
///
///         Règles appliquées :
///           - l'acompte est fixé par le centre (`setDeposit`), jamais par le client ;
///           - il est figé à la réservation : un changement de tarif ne touche pas les réservations existantes ;
///           - annulation ≥ 24 h avant le début (limite incluse) → remboursé au client, sinon → salon ;
///           - prestation validée ou client absent → salon ;
///           - chaque acompte est réglé une seule fois ;
///           - le contrat ne fait que créditer un solde : aucun transfert sortant pendant une réservation,
///             donc un wallet en échec ne bloque jamais une réservation (modèle « pull payment »).
///
///         Invariant comptable (testé) : token.balanceOf(coffre) == totalLocked + totalCredited
///         (sauf jetons envoyés directement au contrat, hors de toute réservation : ils restent alors bloqués).
/// @dev    Contrat abstrait : il est assemblé avec SlotBooking dans BookingEscrow. Les crochets d'EscrowHooks
///         sont `internal` : seul le code du contrat assemblé peut les appeler, jamais un compte extérieur.
///         Jeton supposé standard (MockTND) : les jetons à frais de transfert ne sont pas pris en charge.
abstract contract DepositVault is EscrowHooks, CenterAccess, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Fenêtre de remboursement, exprimée en heures (cahier §9 : pas de délai écrit en secondes).
    uint256 public constant REFUND_WINDOW = 24 hours;

    /// @notice Jeton de l'acompte (MockTND, 6 décimales). Immuable : impossible de le changer après déploiement.
    IERC20 public immutable token;

    /// @dev État de l'acompte d'une réservation. `None` = jamais bloqué. `Settled` est définitif.
    enum DepositStatus {
        None,
        Locked,
        Settled
    }

    /// @dev Acompte d'une réservation, tel que le coffre l'a bloqué.
    ///      client (20 o) + centerId (4 o) + status (1 o) tiennent dans un seul emplacement de stockage ; amount dans un second.
    struct LockedDeposit {
        address client;
        uint32 centerId;
        DepositStatus status;
        uint256 amount;
    }

    /// @dev centerId => acompte exigé (0 = centre non configuré).
    mapping(uint32 => uint256) private _deposits;
    /// @dev centerId => trésorerie (portefeuille du salon).
    mapping(uint32 => address) private _treasuries;
    /// @dev bénéficiaire => solde retirable.
    mapping(address => uint256) private _balances;
    /// @dev bookingId => acompte bloqué.
    mapping(uint256 => LockedDeposit) private _lockedDeposits;

    /// @notice Somme des acomptes bloqués non encore réglés.
    uint256 public totalLocked;
    /// @notice Somme des soldes crédités et non encore retirés.
    uint256 public totalCredited;

    event DepositSet(uint32 indexed centerId, uint256 amount);
    event TreasurySet(uint32 indexed centerId, address indexed treasury);
    event DepositLocked(uint256 indexed bookingId, uint32 indexed centerId, address indexed client, uint256 amount);
    /// @param refunded true = remboursement au client ; false = crédit au salon.
    event DepositCredited(uint256 indexed bookingId, address indexed beneficiary, uint256 amount, bool refunded);
    event Withdrawn(address indexed beneficiary, uint256 amount);

    /// @notice Le centre n'a pas d'acompte ou pas de trésorerie.
    error CenterNotConfigured(uint32 centerId);
    /// @notice Un acompte de 0 a été demandé.
    error InvalidDepositAmount();
    /// @notice Cette réservation a déjà un acompte (bloqué ou réglé).
    error DepositAlreadyLocked(uint256 bookingId);
    /// @notice Aucun acompte bloqué pour cette réservation (inconnue ou déjà réglée).
    error DepositNotLocked(uint256 bookingId);
    /// @notice L'appelant n'a aucun solde à retirer.
    error NothingToWithdraw();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ═══════════════════════ Configuration d'un centre ═══════════════════════

    /// @notice Fixe l'acompte d'un centre, en plus petite unité (30 TND = 30_000_000). Gérant du centre ou administrateur.
    /// @dev    Ne s'applique qu'aux NOUVELLES réservations : chaque réservation a sa copie du montant.
    function setDeposit(uint32 centerId, uint256 amount) external onlyCenterAdmin(centerId) {
        if (amount == 0) revert InvalidDepositAmount();
        _deposits[centerId] = amount;
        emit DepositSet(centerId, amount);
    }

    /// @notice Fixe le portefeuille du salon d'un centre. Gérant du centre ou administrateur.
    /// @dev    Un acompte déjà bloqué sera crédité à la trésorerie EN VIGUEUR AU MOMENT DU RÈGLEMENT (cahier §9, assumé).
    function setTreasury(uint32 centerId, address treasury) external onlyCenterAdmin(centerId) {
        if (treasury == address(0)) revert ZeroAddress();
        _treasuries[centerId] = treasury;
        emit TreasurySet(centerId, treasury);
    }

    // ═══════════════════════════════ Retrait ═══════════════════════════════

    /// @notice Envoie à l'appelant TOUT son solde. Chacun ne peut retirer que le sien : il n'y a pas de paramètre
    ///         « bénéficiaire », le solde lu est toujours celui de `msg.sender`.
    /// @dev    Vérifier → modifier l'état (solde remis à zéro) → transférer. Si un appel malveillant rentrait dans
    ///         `withdraw` pendant le transfert, il trouverait un solde nul ; `nonReentrant` le bloque de toute façon.
    ///         Si le transfert échoue, SafeERC20 annule toute la transaction : le solde est restauré, rien n'est perdu.
    function withdraw() external nonReentrant {
        uint256 amount = _balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        _balances[msg.sender] = 0;
        totalCredited -= amount;

        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════ Lectures ═══════════════════════════════

    /// @notice Solde retirable d'un bénéficiaire (client remboursé ou trésorerie d'un salon).
    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    /// @notice Acompte actuellement exigé par un centre (0 = non configuré).
    function depositOf(uint32 centerId) external view returns (uint256) {
        return _deposits[centerId];
    }

    /// @notice Trésorerie actuelle d'un centre (adresse nulle = non configurée).
    function treasuryOf(uint32 centerId) external view returns (address) {
        return _treasuries[centerId];
    }

    /// @notice Acompte bloqué pour une réservation (lecture pour l'application et les tests).
    function lockedDepositOf(uint256 bookingId) external view returns (LockedDeposit memory) {
        return _lockedDeposits[bookingId];
    }

    // ═══════════════════════ Crochets EscrowHooks (internes) ═══════════════════════

    /// @inheritdoc EscrowHooks
    function _depositFor(uint32 centerId) internal view override returns (uint256) {
        uint256 amount = _deposits[centerId];
        if (amount == 0 || _treasuries[centerId] == address(0)) revert CenterNotConfigured(centerId);
        return amount;
    }

    /// @inheritdoc EscrowHooks
    /// @dev Effets AVANT l'interaction : l'acompte est enregistré, puis le jeton est pris. Si `transferFrom` échoue
    ///      (pas d'approve, solde insuffisant), toute la transaction est annulée, y compris la réservation.
    function _lockDeposit(uint256 bookingId, uint32 centerId, address client)
        internal
        override
        returns (uint256 amount)
    {
        if (client == address(0)) revert ZeroAddress();
        LockedDeposit storage d = _lockedDeposits[bookingId];
        if (d.status != DepositStatus.None) revert DepositAlreadyLocked(bookingId);

        amount = _depositFor(centerId);

        d.client = client;
        d.centerId = centerId;
        d.status = DepositStatus.Locked;
        d.amount = amount;
        totalLocked += amount;

        token.safeTransferFrom(client, address(this), amount);
        emit DepositLocked(bookingId, centerId, client, amount);
    }

    /// @inheritdoc EscrowHooks
    /// @dev Remboursé si `maintenant + 24 h <= début`, autrement dit s'il reste AU MOINS 24 heures.
    ///      Écrit sous forme d'addition pour ne jamais soustraire au-delà de zéro.
    function _settleCancelled(uint256 bookingId, uint64 startTime) internal override returns (bool refunded) {
        LockedDeposit storage d = _takeLocked(bookingId);
        refunded = block.timestamp + REFUND_WINDOW <= startTime;
        address beneficiary = refunded ? d.client : _treasuries[d.centerId];
        _credit(bookingId, beneficiary, d.amount, refunded);
    }

    /// @inheritdoc EscrowHooks
    function _settleToSalon(uint256 bookingId) internal override {
        LockedDeposit storage d = _takeLocked(bookingId);
        _credit(bookingId, _treasuries[d.centerId], d.amount, false);
    }

    // ═══════════════════════════════ Interne ═══════════════════════════════

    /// @dev Vérifie qu'un acompte est bloqué et le passe à `Settled` AVANT tout crédit : un deuxième règlement
    ///      de la même réservation échouera toujours, quel que soit le chemin d'appel.
    function _takeLocked(uint256 bookingId) private returns (LockedDeposit storage d) {
        d = _lockedDeposits[bookingId];
        if (d.status != DepositStatus.Locked) revert DepositNotLocked(bookingId);
        d.status = DepositStatus.Settled;
        totalLocked -= d.amount;
    }

    /// @dev Le montant passe de « bloqué » à « crédité » : aucun jeton ne bouge, seule la comptabilité change.
    ///      `beneficiary` n'est jamais nul : le client a été vérifié au blocage, et `setTreasury` refuse l'adresse nulle
    ///      (un centre sans trésorerie ne peut pas avoir d'acompte bloqué).
    function _credit(uint256 bookingId, address beneficiary, uint256 amount, bool refunded) private {
        _balances[beneficiary] += amount;
        totalCredited += amount;
        emit DepositCredited(bookingId, beneficiary, amount, refunded);
    }
}

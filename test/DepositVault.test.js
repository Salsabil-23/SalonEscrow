// Tests de DepositVault (Membre 2), fonction par fonction, avec un FAUX SlotBooking (VaultHarness).
// Lancer : npm test -- test/DepositVault.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const tnd = (amount) => ethers.parseUnits(String(amount), 6);
const HOUR = 3600;
const CENTER = 1;
const OTHER_CENTER = 2;
const DEPOSIT = tnd(30);

// Statuts de LockedDeposit
const NONE = 0n;
const LOCKED = 1n;
const SETTLED = 2n;

describe("DepositVault", function () {
  // Coffre déployé, centre 1 configuré (30 TND, trésorerie), Alice et Bob ont 100 TND et ont approuvé le coffre.
  async function deployFixture() {
    const [admin, manager, otherManager, treasury, treasury2, staff, alice, bob, stranger] = await ethers.getSigners();
    const token = await ethers.deployContract("MockTND");
    const vault = await ethers.deployContract("VaultHarness", [admin.address, await token.getAddress()]);
    const vaultAddress = await vault.getAddress();

    await vault.connect(admin).setCenterManager(CENTER, manager.address);
    await vault.connect(admin).setCenterManager(OTHER_CENTER, otherManager.address);
    await vault.connect(manager).setDeposit(CENTER, DEPOSIT);
    await vault.connect(manager).setTreasury(CENTER, treasury.address);
    await vault.connect(manager).setStaff(CENTER, staff.address, true);

    for (const client of [alice, bob]) {
      await token.connect(client).faucet(tnd(100));
      await token.connect(client).approve(vaultAddress, ethers.MaxUint256);
    }
    return { token, vault, vaultAddress, admin, manager, otherManager, treasury, treasury2, staff, alice, bob, stranger };
  }

  // Invariant comptable : le coffre détient exactement les acomptes bloqués + les soldes crédités.
  async function expectBalanced(token, vault) {
    const held = await token.balanceOf(await vault.getAddress());
    expect(held).to.equal((await vault.totalLocked()) + (await vault.totalCredited()));
  }

  // Heure de début d'un rendez-vous, `hours` heures après le prochain bloc.
  async function startIn(hours) {
    return BigInt((await time.latest()) + Math.round(hours * HOUR));
  }

  // ═══════════════════════════ Déploiement ═══════════════════════════
  describe("constructor", function () {
    it("enregistre le jeton et l'administrateur", async function () {
      const { token, vault, admin } = await loadFixture(deployFixture);
      expect(await vault.token()).to.equal(await token.getAddress());
      expect(await vault.owner()).to.equal(admin.address);
      expect(await vault.REFUND_WINDOW()).to.equal(24n * 3600n);
    });

    it("refuse un jeton à l'adresse nulle", async function () {
      const [admin] = await ethers.getSigners();
      const factory = await ethers.getContractFactory("VaultHarness");
      await expect(factory.deploy(admin.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("refuse un administrateur à l'adresse nulle (Ownable)", async function () {
      const { token } = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("VaultHarness");
      await expect(factory.deploy(ethers.ZeroAddress, await token.getAddress()))
        .to.be.revertedWithCustomError(factory, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);
    });
  });

  // ═══════════════════════════ Rôles (CenterAccess) ═══════════════════════════
  describe("CenterAccess", function () {
    it("seul l'administrateur nomme un gérant", async function () {
      const { vault, manager, stranger } = await loadFixture(deployFixture);
      await expect(vault.connect(manager).setCenterManager(CENTER, stranger.address))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(manager.address);
    });

    it("setCenterManager émet CenterManagerSet et refuse l'adresse nulle", async function () {
      const { vault, admin, stranger } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).setCenterManager(3, stranger.address))
        .to.emit(vault, "CenterManagerSet")
        .withArgs(3, stranger.address);
      expect(await vault.managerOf(3)).to.equal(stranger.address);
      await expect(vault.connect(admin).setCenterManager(3, ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("le gérant et l'administrateur gèrent le staff de leur centre", async function () {
      const { vault, admin, manager, stranger } = await loadFixture(deployFixture);
      await expect(vault.connect(manager).setStaff(CENTER, stranger.address, true))
        .to.emit(vault, "StaffSet")
        .withArgs(CENTER, stranger.address, true);
      expect(await vault.isStaff(CENTER, stranger.address)).to.equal(true);
      await vault.connect(admin).setStaff(CENTER, stranger.address, false);
      expect(await vault.isStaff(CENTER, stranger.address)).to.equal(false);
    });

    it("le gérant d'un autre centre, le staff et un inconnu ne gèrent pas le staff", async function () {
      const { vault, otherManager, staff, stranger } = await loadFixture(deployFixture);
      for (const caller of [otherManager, staff, stranger]) {
        await expect(vault.connect(caller).setStaff(CENTER, stranger.address, true))
          .to.be.revertedWithCustomError(vault, "NotCenterManager")
          .withArgs(CENTER, caller.address);
      }
    });

    it("setStaff refuse l'adresse nulle", async function () {
      const { vault, manager } = await loadFixture(deployFixture);
      await expect(vault.connect(manager).setStaff(CENTER, ethers.ZeroAddress, true)).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("le gérant n'est pas staff par défaut", async function () {
      const { vault, manager } = await loadFixture(deployFixture);
      expect(await vault.isStaff(CENTER, manager.address)).to.equal(false);
    });
  });

  // ═══════════════════════════ setDeposit ═══════════════════════════
  describe("setDeposit", function () {
    it("le gérant fixe l'acompte de son centre et l'événement DepositSet est émis", async function () {
      const { vault, manager } = await loadFixture(deployFixture);
      await expect(vault.connect(manager).setDeposit(CENTER, tnd(45))).to.emit(vault, "DepositSet").withArgs(CENTER, tnd(45));
      expect(await vault.depositOf(CENTER)).to.equal(tnd(45));
    });

    it("l'administrateur peut configurer n'importe quel centre", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await vault.connect(admin).setDeposit(OTHER_CENTER, tnd(20));
      expect(await vault.depositOf(OTHER_CENTER)).to.equal(tnd(20));
    });

    it("le gérant d'un autre centre, le staff, un client ou un inconnu sont refusés", async function () {
      const { vault, otherManager, staff, alice, stranger } = await loadFixture(deployFixture);
      for (const caller of [otherManager, staff, alice, stranger]) {
        await expect(vault.connect(caller).setDeposit(CENTER, tnd(1)))
          .to.be.revertedWithCustomError(vault, "NotCenterManager")
          .withArgs(CENTER, caller.address);
      }
      expect(await vault.depositOf(CENTER)).to.equal(DEPOSIT);
    });

    it("refuse un acompte de 0", async function () {
      const { vault, manager } = await loadFixture(deployFixture);
      await expect(vault.connect(manager).setDeposit(CENTER, 0)).to.be.revertedWithCustomError(vault, "InvalidDepositAmount");
    });
  });

  // ═══════════════════════════ setTreasury ═══════════════════════════
  describe("setTreasury", function () {
    it("le gérant fixe la trésorerie de son centre et l'événement TreasurySet est émis", async function () {
      const { vault, manager, treasury2 } = await loadFixture(deployFixture);
      await expect(vault.connect(manager).setTreasury(CENTER, treasury2.address))
        .to.emit(vault, "TreasurySet")
        .withArgs(CENTER, treasury2.address);
      expect(await vault.treasuryOf(CENTER)).to.equal(treasury2.address);
    });

    it("l'administrateur peut fixer la trésorerie de n'importe quel centre", async function () {
      const { vault, admin, treasury2 } = await loadFixture(deployFixture);
      await vault.connect(admin).setTreasury(OTHER_CENTER, treasury2.address);
      expect(await vault.treasuryOf(OTHER_CENTER)).to.equal(treasury2.address);
    });

    it("le gérant d'un autre centre, le staff ou un inconnu sont refusés", async function () {
      const { vault, otherManager, staff, stranger } = await loadFixture(deployFixture);
      for (const caller of [otherManager, staff, stranger]) {
        await expect(vault.connect(caller).setTreasury(CENTER, caller.address))
          .to.be.revertedWithCustomError(vault, "NotCenterManager")
          .withArgs(CENTER, caller.address);
      }
    });

    it("refuse l'adresse nulle", async function () {
      const { vault, manager } = await loadFixture(deployFixture);
      await expect(vault.connect(manager).setTreasury(CENTER, ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });
  });

  // ═══════════════════════════ _depositFor ═══════════════════════════
  describe("_depositFor", function () {
    it("renvoie l'acompte d'un centre configuré", async function () {
      const { vault } = await loadFixture(deployFixture);
      expect(await vault.depositFor(CENTER)).to.equal(DEPOSIT);
    });

    it("refuse un centre sans acompte", async function () {
      const { vault, admin, treasury } = await loadFixture(deployFixture);
      await vault.connect(admin).setTreasury(OTHER_CENTER, treasury.address);
      await expect(vault.depositFor(OTHER_CENTER)).to.be.revertedWithCustomError(vault, "CenterNotConfigured").withArgs(OTHER_CENTER);
    });

    it("refuse un centre sans trésorerie", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await vault.connect(admin).setDeposit(OTHER_CENTER, tnd(10));
      await expect(vault.depositFor(OTHER_CENTER)).to.be.revertedWithCustomError(vault, "CenterNotConfigured").withArgs(OTHER_CENTER);
    });
  });

  // ═══════════════════════════ _lockDeposit ═══════════════════════════
  describe("_lockDeposit", function () {
    it("prend l'acompte du centre au client et l'enregistre", async function () {
      const { token, vault, alice } = await loadFixture(deployFixture);
      await expect(vault.connect(alice).book(1, CENTER)).to.changeTokenBalances(token, [alice, vault], [-DEPOSIT, DEPOSIT]);

      const d = await vault.lockedDepositOf(1);
      expect(d.client).to.equal(alice.address);
      expect(d.centerId).to.equal(BigInt(CENTER));
      expect(d.status).to.equal(LOCKED);
      expect(d.amount).to.equal(DEPOSIT);
      expect(await vault.totalLocked()).to.equal(DEPOSIT);
      expect(await vault.balanceOf(alice.address)).to.equal(0n); // bloqué ≠ retirable
      await expectBalanced(token, vault);
    });

    it("émet DepositLocked et renvoie le montant bloqué", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      expect(await vault.connect(alice).book.staticCall(1, CENTER)).to.equal(DEPOSIT);
      await expect(vault.connect(alice).book(1, CENTER))
        .to.emit(vault, "DepositLocked")
        .withArgs(1, CENTER, alice.address, DEPOSIT);
    });

    it("prend le montant du centre, même si le client a approuvé davantage", async function () {
      const { token, vault, alice } = await loadFixture(deployFixture); // approve = MaxUint256
      await vault.connect(alice).book(1, CENTER);
      expect(await token.balanceOf(alice.address)).to.equal(tnd(100) - DEPOSIT);
    });

    it("un changement de tarif ne modifie pas l'acompte d'une réservation existante", async function () {
      const { token, vault, manager, treasury, alice, bob } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER); // 30 TND
      await vault.connect(manager).setDeposit(CENTER, tnd(50));
      await vault.connect(bob).book(2, CENTER); // 50 TND

      expect((await vault.lockedDepositOf(1)).amount).to.equal(tnd(30));
      expect((await vault.lockedDepositOf(2)).amount).to.equal(tnd(50));
      await vault.settleToSalon(1);
      expect(await vault.balanceOf(treasury.address)).to.equal(tnd(30));
      await expectBalanced(token, vault);
    });

    it("refuse de bloquer deux fois la même réservation", async function () {
      const { vault, alice, bob } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await expect(vault.connect(bob).book(1, CENTER)).to.be.revertedWithCustomError(vault, "DepositAlreadyLocked").withArgs(1);
    });

    it("refuse de rebloquer une réservation déjà réglée", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await vault.settleToSalon(1);
      await expect(vault.connect(alice).book(1, CENTER)).to.be.revertedWithCustomError(vault, "DepositAlreadyLocked").withArgs(1);
    });

    it("refuse un centre non configuré, sans rien prendre", async function () {
      const { token, vault, alice } = await loadFixture(deployFixture);
      await expect(vault.connect(alice).book(1, OTHER_CENTER))
        .to.be.revertedWithCustomError(vault, "CenterNotConfigured")
        .withArgs(OTHER_CENTER);
      expect(await token.balanceOf(alice.address)).to.equal(tnd(100));
    });

    it("sans approve : échec, rien n'est enregistré ni pris", async function () {
      const { token, vault, vaultAddress, alice } = await loadFixture(deployFixture);
      await token.connect(alice).approve(vaultAddress, 0);
      await expect(vault.connect(alice).book(1, CENTER))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance")
        .withArgs(vaultAddress, 0, DEPOSIT);
      expect((await vault.lockedDepositOf(1)).status).to.equal(NONE);
      expect(await vault.totalLocked()).to.equal(0n);
      expect(await token.balanceOf(alice.address)).to.equal(tnd(100));
    });

    it("allocation insuffisante d'une unité : échec", async function () {
      const { token, vault, vaultAddress, alice } = await loadFixture(deployFixture);
      await token.connect(alice).approve(vaultAddress, DEPOSIT - 1n);
      await expect(vault.connect(alice).book(1, CENTER)).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });

    it("solde insuffisant : échec, rien n'est enregistré", async function () {
      const { token, vault, stranger, vaultAddress } = await loadFixture(deployFixture);
      await token.connect(stranger).faucet(tnd(29));
      await token.connect(stranger).approve(vaultAddress, DEPOSIT);
      await expect(vault.connect(stranger).book(1, CENTER))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(stranger.address, tnd(29), DEPOSIT);
      expect((await vault.lockedDepositOf(1)).status).to.equal(NONE);
    });
  });

  // ═══════════════════════════ _settleCancelled ═══════════════════════════
  describe("_settleCancelled (règle des 24 heures)", function () {
    // Bloque l'acompte d'Alice pour un rendez-vous à `start`, puis annule exactement à `start - secondsBefore`.
    async function cancelAt(fx, start, secondsBefore) {
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await time.setNextBlockTimestamp(start - BigInt(secondsBefore));
      return fx.vault.cancel(1, start);
    }

    it("annulation 30 h avant : remboursement au client", async function () {
      const fx = await loadFixture(deployFixture);
      const start = await startIn(48);
      await expect(cancelAt(fx, start, 30 * HOUR))
        .to.emit(fx.vault, "DepositCredited")
        .withArgs(1, fx.alice.address, DEPOSIT, true);
      expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(DEPOSIT);
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(0n);
    });

    it("annulation à 24 h pile : remboursement (limite incluse)", async function () {
      const fx = await loadFixture(deployFixture);
      const start = await startIn(48);
      await expect(cancelAt(fx, start, 24 * HOUR))
        .to.emit(fx.vault, "DepositCredited")
        .withArgs(1, fx.alice.address, DEPOSIT, true);
    });

    it("annulation à 23 h 59 min 59 s : acompte au salon", async function () {
      const fx = await loadFixture(deployFixture);
      const start = await startIn(48);
      await expect(cancelAt(fx, start, 24 * HOUR - 1))
        .to.emit(fx.vault, "DepositCredited")
        .withArgs(1, fx.treasury.address, DEPOSIT, false);
      expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(0n);
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
    });

    it("annulation 2 h avant : acompte au salon", async function () {
      const fx = await loadFixture(deployFixture);
      const start = await startIn(48);
      await cancelAt(fx, start, 2 * HOUR);
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
    });

    it("renvoie l'indicateur refunded", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      expect(await fx.vault.cancel.staticCall(1, await startIn(48))).to.equal(true);
      expect(await fx.vault.cancel.staticCall(1, await startIn(1))).to.equal(false);
    });

    it("après l'heure de début (si SlotBooking laissait passer) : salon, sans erreur de calcul", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      const pastStart = BigInt(await time.latest()) - 10n;
      await fx.vault.cancel(1, pastStart);
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
    });

    it("met à jour la comptabilité : bloqué → crédité", async function () {
      const fx = await loadFixture(deployFixture);
      await cancelAt(fx, await startIn(48), 30 * HOUR);
      expect(await fx.vault.totalLocked()).to.equal(0n);
      expect(await fx.vault.totalCredited()).to.equal(DEPOSIT);
      expect((await fx.vault.lockedDepositOf(1)).status).to.equal(SETTLED);
      await expectBalanced(fx.token, fx.vault);
    });

    it("refuse une réservation inconnue", async function () {
      const { vault } = await loadFixture(deployFixture);
      await expect(vault.cancel(99, await startIn(48))).to.be.revertedWithCustomError(vault, "DepositNotLocked").withArgs(99);
    });

    it("double règlement : deuxième annulation refusée", async function () {
      const fx = await loadFixture(deployFixture);
      const start = await startIn(48);
      await cancelAt(fx, start, 30 * HOUR);
      await expect(fx.vault.cancel(1, start)).to.be.revertedWithCustomError(fx.vault, "DepositNotLocked").withArgs(1);
      expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(DEPOSIT);
    });

    it("le salon perçu est la trésorerie en vigueur au moment du règlement", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await fx.vault.connect(fx.manager).setTreasury(CENTER, fx.treasury2.address);
      await fx.vault.cancel(1, await startIn(1));
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(0n);
      expect(await fx.vault.balanceOf(fx.treasury2.address)).to.equal(DEPOSIT);
    });
  });

  // ═══════════════════════════ _settleToSalon ═══════════════════════════
  describe("_settleToSalon (prestation validée ou absence)", function () {
    it("crédite la trésorerie du centre", async function () {
      const { token, vault, alice, treasury } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await expect(vault.settleToSalon(1)).to.emit(vault, "DepositCredited").withArgs(1, treasury.address, DEPOSIT, false);
      expect(await vault.balanceOf(treasury.address)).to.equal(DEPOSIT);
      expect(await vault.balanceOf(alice.address)).to.equal(0n);
      expect(await vault.totalLocked()).to.equal(0n);
      await expectBalanced(token, vault);
    });

    it("ne déplace aucun jeton : seule la comptabilité change", async function () {
      const { token, vault, alice, treasury } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await expect(vault.settleToSalon(1)).to.changeTokenBalances(token, [vault, treasury], [0n, 0n]);
    });

    it("double règlement refusé (validation répétée)", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await vault.settleToSalon(1);
      await expect(vault.settleToSalon(1)).to.be.revertedWithCustomError(vault, "DepositNotLocked").withArgs(1);
    });

    it("refusé après une annulation (un seul règlement, quel que soit le chemin)", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await vault.cancel(1, await startIn(48));
      await expect(vault.settleToSalon(1)).to.be.revertedWithCustomError(vault, "DepositNotLocked");
    });

    it("refuse une réservation inconnue", async function () {
      const { vault } = await loadFixture(deployFixture);
      await expect(vault.settleToSalon(7)).to.be.revertedWithCustomError(vault, "DepositNotLocked").withArgs(7);
    });
  });

  // ═══════════════════════════ withdraw ═══════════════════════════
  describe("withdraw", function () {
    it("le client remboursé retire son solde : jetons envoyés, solde à zéro, Withdrawn émis", async function () {
      const { token, vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await vault.cancel(1, await startIn(48));

      const tx = vault.connect(alice).withdraw();
      await expect(tx).to.changeTokenBalances(token, [vault, alice], [-DEPOSIT, DEPOSIT]);
      await expect(tx).to.emit(vault, "Withdrawn").withArgs(alice.address, DEPOSIT);
      expect(await vault.balanceOf(alice.address)).to.equal(0n);
      expect(await vault.totalCredited()).to.equal(0n);
      expect(await token.balanceOf(alice.address)).to.equal(tnd(100));
      await expectBalanced(token, vault);
    });

    it("la trésorerie retire les acomptes accumulés en une fois", async function () {
      const { token, vault, alice, bob, treasury } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await vault.connect(bob).book(2, CENTER);
      await vault.settleToSalon(1);
      await vault.settleToSalon(2);
      await expect(vault.connect(treasury).withdraw()).to.changeTokenBalance(token, treasury, DEPOSIT * 2n);
    });

    it("sans solde : NothingToWithdraw", async function () {
      const { vault, stranger } = await loadFixture(deployFixture);
      await expect(vault.connect(stranger).withdraw()).to.be.revertedWithCustomError(vault, "NothingToWithdraw");
    });

    it("un acompte encore bloqué n'est pas retirable", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await expect(vault.connect(alice).withdraw()).to.be.revertedWithCustomError(vault, "NothingToWithdraw");
    });

    it("deuxième retrait refusé : le solde a été remis à zéro", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await vault.cancel(1, await startIn(48));
      await vault.connect(alice).withdraw();
      await expect(vault.connect(alice).withdraw()).to.be.revertedWithCustomError(vault, "NothingToWithdraw");
    });

    it("personne d'autre ne peut retirer le solde d'un bénéficiaire", async function () {
      const { vault, alice, treasury, manager, admin, stranger } = await loadFixture(deployFixture);
      await vault.connect(alice).book(1, CENTER);
      await vault.settleToSalon(1);
      for (const caller of [alice, manager, admin, stranger]) {
        await expect(vault.connect(caller).withdraw()).to.be.revertedWithCustomError(vault, "NothingToWithdraw");
      }
      expect(await vault.balanceOf(treasury.address)).to.equal(DEPOSIT);
    });

    it("réentrance : un bénéficiaire qui rappelle withdraw pendant le transfert est bloqué", async function () {
      const [admin, , , treasury] = await ethers.getSigners();
      const hook = await ethers.deployContract("HookToken");
      const vault = await ethers.deployContract("VaultHarness", [admin.address, await hook.getAddress()]);
      await vault.setDeposit(CENTER, DEPOSIT);
      await vault.setTreasury(CENTER, treasury.address);

      const attacker = await ethers.deployContract("ReentrantWithdrawer", [await vault.getAddress(), await hook.getAddress()]);
      await hook.mint(await attacker.getAddress(), DEPOSIT);
      await attacker.book(1, CENTER);
      await vault.cancel(1, await startIn(48)); // remboursé : solde de 30 TND
      await hook.setHookTarget(await attacker.getAddress());

      await expect(attacker.attack()).to.be.revertedWithCustomError(vault, "ReentrancyGuardReentrantCall");
      // Rien n'a bougé : la transaction entière a été annulée.
      expect(await vault.balanceOf(await attacker.getAddress())).to.equal(DEPOSIT);
      expect(await hook.balanceOf(await vault.getAddress())).to.equal(DEPOSIT);
    });

    it("transfert en échec (jeton qui renvoie false) : SafeERC20 annule, le solde est conservé", async function () {
      const [admin, , , treasury, , , alice] = await ethers.getSigners();
      const bad = await ethers.deployContract("FalseReturningToken");
      const vault = await ethers.deployContract("VaultHarness", [admin.address, await bad.getAddress()]);
      await vault.setDeposit(CENTER, DEPOSIT);
      await vault.setTreasury(CENTER, treasury.address);
      await bad.mint(alice.address, DEPOSIT);
      await bad.connect(alice).approve(await vault.getAddress(), DEPOSIT);
      await vault.connect(alice).book(1, CENTER);
      await vault.cancel(1, await startIn(48));

      await bad.setFailTransfers(true);
      await expect(vault.connect(alice).withdraw())
        .to.be.revertedWithCustomError(vault, "SafeERC20FailedOperation")
        .withArgs(await bad.getAddress());
      expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT);
      expect(await vault.totalCredited()).to.equal(DEPOSIT);

      await bad.setFailTransfers(false); // une fois le problème réglé, le retrait fonctionne
      await vault.connect(alice).withdraw();
      expect(await bad.balanceOf(alice.address)).to.equal(DEPOSIT);
    });
  });

  // ═══════════════════════════ Lectures ═══════════════════════════
  describe("balanceOf / depositOf / treasuryOf", function () {
    it("valeurs nulles pour un compte ou un centre inconnu", async function () {
      const { vault, stranger } = await loadFixture(deployFixture);
      expect(await vault.balanceOf(stranger.address)).to.equal(0n);
      expect(await vault.depositOf(42)).to.equal(0n);
      expect(await vault.treasuryOf(42)).to.equal(ethers.ZeroAddress);
      expect((await vault.lockedDepositOf(42)).status).to.equal(NONE);
    });

    it("valeurs du centre configuré", async function () {
      const { vault, treasury } = await loadFixture(deployFixture);
      expect(await vault.depositOf(CENTER)).to.equal(DEPOSIT);
      expect(await vault.treasuryOf(CENTER)).to.equal(treasury.address);
    });
  });
});

// Scénarios financiers de bout en bout (Membre 2), côté coffre, avec le faux SlotBooking (VaultHarness).
// Chaque scénario suit l'argent jusqu'au bout : wallet du client → coffre → solde → wallet du bénéficiaire.
//
// Hors de ce fichier : les contrôles de DATE propres à SlotBooking (Membre 1) — absence refusée avant 15 minutes,
// validation refusée avant l'heure de début, annulation refusée après le début. Ils sont testés à l'étape 5
// sur le contrat assemblé BookingEscrow. Ici, on vérifie ce que fait l'ARGENT une fois ces contrôles passés.
//
// Lancer : npm test -- test/FinancialScenarios.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const tnd = (amount) => ethers.parseUnits(String(amount), 6);
const HOUR = 3600n;
const MINUTE = 60n;
const CENTER = 1;
const CENTER_B = 2;
const DEPOSIT = tnd(30);
const START_FUNDS = tnd(100);

describe("Scénarios financiers", function () {
  async function deployFixture() {
    const [admin, manager, managerB, treasury, treasuryB, newTreasury, alice, bob, carol, stranger] = await ethers.getSigners();
    const token = await ethers.deployContract("MockTND");
    const vault = await ethers.deployContract("VaultHarness", [admin.address, await token.getAddress()]);
    const vaultAddress = await vault.getAddress();

    await vault.setCenterManager(CENTER, manager.address);
    await vault.setCenterManager(CENTER_B, managerB.address);
    await vault.connect(manager).setDeposit(CENTER, DEPOSIT);
    await vault.connect(manager).setTreasury(CENTER, treasury.address);
    await vault.connect(managerB).setDeposit(CENTER_B, tnd(20));
    await vault.connect(managerB).setTreasury(CENTER_B, treasuryB.address);

    const clients = [alice, bob, carol];
    for (const c of clients) {
      await token.connect(c).faucet(START_FUNDS);
      await token.connect(c).approve(vaultAddress, ethers.MaxUint256);
    }
    return { token, vault, vaultAddress, admin, manager, managerB, treasury, treasuryB, newTreasury, alice, bob, carol, stranger, clients };
  }

  // Aucun jeton créé ni perdu : le coffre détient exactement bloqué + crédité.
  async function expectBalanced({ token, vault }) {
    expect(await token.balanceOf(await vault.getAddress())).to.equal((await vault.totalLocked()) + (await vault.totalCredited()));
  }

  // Annule la réservation `bookingId` exactement `before` secondes avant son début (`before` en BigInt).
  async function cancelBefore(vault, bookingId, before) {
    const now = BigInt(await time.latest()) + 1n;
    const start = now + before;
    await time.setNextBlockTimestamp(now);
    return vault.cancel(bookingId, start);
  }

  // ─────────────────────────── Règle des 24 heures ───────────────────────────
  describe("Annulation", function () {
    it("30 h avant : remboursement complet, le client retire ses 30 TND et retrouve ses 100 TND", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      expect(await fx.token.balanceOf(fx.alice.address)).to.equal(tnd(70));

      await cancelBefore(fx.vault, 1, 30n * HOUR);
      expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(DEPOSIT);
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(0n);

      await fx.vault.connect(fx.alice).withdraw();
      expect(await fx.token.balanceOf(fx.alice.address)).to.equal(START_FUNDS);
      expect(await fx.token.balanceOf(fx.vaultAddress)).to.equal(0n);
      await expectBalanced(fx);
    });

    it("24 h pile : remboursement (limite incluse)", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await expect(cancelBefore(fx.vault, 1, 24n * HOUR))
        .to.emit(fx.vault, "DepositCredited")
        .withArgs(1, fx.alice.address, DEPOSIT, true);
    });

    it("23 h 59 min 59 s : acompte crédité au salon", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await expect(cancelBefore(fx.vault, 1, 24n * HOUR - 1n))
        .to.emit(fx.vault, "DepositCredited")
        .withArgs(1, fx.treasury.address, DEPOSIT, false);
      expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(0n);
    });

    it("annulation tardive (2 h avant) : le salon retire l'acompte, le client n'a rien à retirer", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await cancelBefore(fx.vault, 1, 2n * HOUR);

      await expect(fx.vault.connect(fx.alice).withdraw()).to.be.revertedWithCustomError(fx.vault, "NothingToWithdraw");
      await expect(fx.vault.connect(fx.treasury).withdraw()).to.changeTokenBalance(fx.token, fx.treasury, DEPOSIT);
      expect(await fx.token.balanceOf(fx.alice.address)).to.equal(tnd(70));
      await expectBalanced(fx);
    });

    it("annulation 1 minute avant le début : salon", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await cancelBefore(fx.vault, 1, MINUTE);
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
    });
  });

  // ─────────────────────────── Prestation et absence ───────────────────────────
  describe("Prestation validée et absence", function () {
    it("prestation validée : acompte au salon, retiré par la trésorerie", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await fx.vault.settleToSalon(1); // markCompleted, contrôles de SlotBooking passés
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
      await expect(fx.vault.connect(fx.treasury).withdraw()).to.changeTokenBalance(fx.token, fx.treasury, DEPOSIT);
      await expectBalanced(fx);
    });

    it("client absent : acompte au salon, le client ne récupère rien", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.bob).book(1, CENTER);
      await fx.vault.settleToSalon(1); // markNoShow, contrôles de SlotBooking passés
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
      await expect(fx.vault.connect(fx.bob).withdraw()).to.be.revertedWithCustomError(fx.vault, "NothingToWithdraw");
      expect(await fx.token.balanceOf(fx.bob.address)).to.equal(tnd(70));
    });

    it("les quatre situations à la suite (démonstration) : soldes à chaque étape", async function () {
      const fx = await loadFixture(deployFixture);
      // 1 annulation à temps (Alice) · 2 annulation tardive (Bob) · 3 absence (Carol) · 4 prestation validée (Alice)
      for (const [id, client] of [[1, fx.alice], [2, fx.bob], [3, fx.carol], [4, fx.alice]]) {
        await fx.vault.connect(client).book(id, CENTER);
      }
      expect(await fx.vault.totalLocked()).to.equal(DEPOSIT * 4n);

      await cancelBefore(fx.vault, 1, 48n * HOUR);
      await cancelBefore(fx.vault, 2, 3n * HOUR);
      await fx.vault.settleToSalon(3);
      await fx.vault.settleToSalon(4);

      expect(await fx.vault.totalLocked()).to.equal(0n);
      expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(DEPOSIT); // seulement la réservation 1
      expect(await fx.vault.balanceOf(fx.bob.address)).to.equal(0n);
      expect(await fx.vault.balanceOf(fx.carol.address)).to.equal(0n);
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(DEPOSIT * 3n);
      await expectBalanced(fx);

      await fx.vault.connect(fx.alice).withdraw();
      await fx.vault.connect(fx.treasury).withdraw();
      expect(await fx.token.balanceOf(fx.vaultAddress)).to.equal(0n);
      expect(await fx.token.balanceOf(fx.treasury.address)).to.equal(tnd(90));
      expect(await fx.token.balanceOf(fx.alice.address)).to.equal(tnd(70)); // 100 − 60 + 30
    });
  });

  // ─────────────────────────── Retraits ───────────────────────────
  describe("Retraits", function () {
    it("retrait réussi : wallet crédité, solde à zéro, Withdrawn émis", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await fx.vault.settleToSalon(1);
      await expect(fx.vault.connect(fx.treasury).withdraw()).to.emit(fx.vault, "Withdrawn").withArgs(fx.treasury.address, DEPOSIT);
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(0n);
    });

    it("retrait sans solde : NothingToWithdraw", async function () {
      const fx = await loadFixture(deployFixture);
      await expect(fx.vault.connect(fx.stranger).withdraw()).to.be.revertedWithCustomError(fx.vault, "NothingToWithdraw");
    });

    it("retrait non autorisé : ni le gérant, ni l'administrateur, ni le client ne vident la trésorerie", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await fx.vault.settleToSalon(1);
      for (const caller of [fx.manager, fx.admin, fx.alice, fx.stranger, fx.treasuryB]) {
        await expect(fx.vault.connect(caller).withdraw()).to.be.revertedWithCustomError(fx.vault, "NothingToWithdraw");
      }
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
      expect(await fx.token.balanceOf(fx.vaultAddress)).to.equal(DEPOSIT);
    });

    it("retrait non autorisé : un client ne retire pas le remboursement d'un autre", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await cancelBefore(fx.vault, 1, 30n * HOUR);
      await expect(fx.vault.connect(fx.bob).withdraw()).to.be.revertedWithCustomError(fx.vault, "NothingToWithdraw");
      expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(DEPOSIT);
    });
  });

  // ─────────────────────────── Double règlement ───────────────────────────
  describe("Double règlement", function () {
    const settle = {
      cancel: (vault, id) => cancelBefore(vault, id, 30n * HOUR),
      lateCancel: (vault, id) => cancelBefore(vault, id, HOUR),
      salon: (vault, id) => vault.settleToSalon(id),
    };
    for (const first of Object.keys(settle)) {
      for (const second of Object.keys(settle)) {
        it(`${first} puis ${second} : le deuxième est refusé, un seul crédit`, async function () {
          const fx = await loadFixture(deployFixture);
          await fx.vault.connect(fx.alice).book(1, CENTER);
          await settle[first](fx.vault, 1);
          const credited = await fx.vault.totalCredited();
          await expect(settle[second](fx.vault, 1)).to.be.revertedWithCustomError(fx.vault, "DepositNotLocked").withArgs(1);
          expect(await fx.vault.totalCredited()).to.equal(credited);
          expect(credited).to.equal(DEPOSIT);
          await expectBalanced(fx);
        });
      }
    }

    it("après retrait, régler de nouveau la même réservation reste refusé", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await fx.vault.settleToSalon(1);
      await fx.vault.connect(fx.treasury).withdraw();
      await expect(fx.vault.settleToSalon(1)).to.be.revertedWithCustomError(fx.vault, "DepositNotLocked");
      await expect(fx.vault.connect(fx.treasury).withdraw()).to.be.revertedWithCustomError(fx.vault, "NothingToWithdraw");
    });
  });

  // ─────────────────────────── Échecs à la réservation ───────────────────────────
  describe("Réservation qui échoue", function () {
    it("solde insuffisant : la réservation échoue, rien n'est bloqué", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.token.connect(fx.stranger).faucet(tnd(10));
      await fx.token.connect(fx.stranger).approve(fx.vaultAddress, ethers.MaxUint256);
      await expect(fx.vault.connect(fx.stranger).book(1, CENTER)).to.be.revertedWithCustomError(fx.token, "ERC20InsufficientBalance");
      expect(await fx.vault.totalLocked()).to.equal(0n);
      expect(await fx.token.balanceOf(fx.stranger.address)).to.equal(tnd(10));
      // la même réservation peut ensuite être payée par un client solvable
      await fx.vault.connect(fx.alice).book(1, CENTER);
      expect((await fx.vault.lockedDepositOf(1)).client).to.equal(fx.alice.address);
    });

    it("allocation insuffisante : la réservation échoue, rien n'est bloqué", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.token.connect(fx.alice).approve(fx.vaultAddress, tnd(29));
      await expect(fx.vault.connect(fx.alice).book(1, CENTER)).to.be.revertedWithCustomError(fx.token, "ERC20InsufficientAllowance");
      expect(await fx.vault.totalLocked()).to.equal(0n);
      expect(await fx.token.allowance(fx.alice.address, fx.vaultAddress)).to.equal(tnd(29));
    });

    it("approve exact : l'allocation est entièrement consommée", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.token.connect(fx.alice).approve(fx.vaultAddress, DEPOSIT);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      expect(await fx.token.allowance(fx.alice.address, fx.vaultAddress)).to.equal(0n);
      await expect(fx.vault.connect(fx.alice).book(2, CENTER)).to.be.revertedWithCustomError(fx.token, "ERC20InsufficientAllowance");
    });
  });

  // ─────────────────────────── Changement de tarif ───────────────────────────
  describe("Changement de tarif", function () {
    it("chaque réservation est réglée avec SON montant d'origine, quel que soit le tarif ensuite", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER); // 30
      await fx.vault.connect(fx.manager).setDeposit(CENTER, tnd(50));
      await fx.vault.connect(fx.bob).book(2, CENTER); // 50
      await fx.vault.connect(fx.manager).setDeposit(CENTER, tnd(10));

      await cancelBefore(fx.vault, 1, 30n * HOUR); // Alice : 30 remboursés (pas 10)
      await fx.vault.settleToSalon(2); // salon : 50 (pas 10)

      expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(tnd(30));
      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(tnd(50));
      await fx.vault.connect(fx.alice).withdraw();
      expect(await fx.token.balanceOf(fx.alice.address)).to.equal(START_FUNDS);
      await expectBalanced(fx);
    });

    it("le nouveau tarif s'applique aux nouvelles réservations", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.manager).setDeposit(CENTER, tnd(45));
      await expect(fx.vault.connect(fx.alice).book(1, CENTER)).to.changeTokenBalance(fx.token, fx.alice, -tnd(45));
    });
  });

  // ─────────────────────────── Configuration de la trésorerie ───────────────────────────
  describe("Configuration de la trésorerie", function () {
    it("seuls le gérant du centre et l'administrateur la modifient", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.manager).setTreasury(CENTER, fx.newTreasury.address);
      await fx.vault.connect(fx.admin).setTreasury(CENTER, fx.treasury.address);
      for (const caller of [fx.managerB, fx.treasury, fx.alice, fx.stranger]) {
        await expect(fx.vault.connect(caller).setTreasury(CENTER, caller.address))
          .to.be.revertedWithCustomError(fx.vault, "NotCenterManager")
          .withArgs(CENTER, caller.address);
      }
      expect(await fx.vault.treasuryOf(CENTER)).to.equal(fx.treasury.address);
    });

    it("la trésorerie elle-même ne peut pas se remplacer", async function () {
      const fx = await loadFixture(deployFixture);
      await expect(fx.vault.connect(fx.treasury).setTreasury(CENTER, fx.stranger.address)).to.be.revertedWithCustomError(
        fx.vault,
        "NotCenterManager",
      );
    });

    it("un changement de trésorerie ne déplace pas un solde déjà crédité", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, CENTER);
      await fx.vault.settleToSalon(1); // crédité à l'ancienne trésorerie
      await fx.vault.connect(fx.manager).setTreasury(CENTER, fx.newTreasury.address);
      await fx.vault.connect(fx.bob).book(2, CENTER);
      await fx.vault.settleToSalon(2); // crédité à la nouvelle

      expect(await fx.vault.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
      expect(await fx.vault.balanceOf(fx.newTreasury.address)).to.equal(DEPOSIT);
      await fx.vault.connect(fx.treasury).withdraw(); // l'ancienne retire toujours ce qui lui revient
      await expectBalanced(fx);
    });

    it("le gérant du centre B ne touche ni l'acompte ni la trésorerie du centre A", async function () {
      const fx = await loadFixture(deployFixture);
      await expect(fx.vault.connect(fx.managerB).setDeposit(CENTER, 1n)).to.be.revertedWithCustomError(fx.vault, "NotCenterManager");
      await expect(fx.vault.connect(fx.managerB).setTreasury(CENTER, fx.managerB.address)).to.be.revertedWithCustomError(
        fx.vault,
        "NotCenterManager",
      );
    });
  });
});

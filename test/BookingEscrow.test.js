// Contrat assemblé BookingEscrow (SlotBooking + DepositVault) avec le vrai jeton MockTND.
// Membre 1 : scénario 1 (double réservation) et scénario 6 (comptes non autorisés), vérifiés jusqu'aux jetons.
// Commun : les contrôles de DATE de SlotBooking combinés à l'argent du coffre (renvoyés ici par FinancialScenarios.test.js).
//
// Lancer : npm test -- test/BookingEscrow.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const tnd = (amount) => ethers.parseUnits(String(amount), 6);
const HOUR = 3600;
const HALF_HOUR = 1800;
const CENTER = 1;
const CENTER_B = 2;
const PRACTITIONER = 7;
const DEPOSIT = tnd(30);
const START_FUNDS = tnd(100);
const Status = { None: 0n, Confirmed: 1n, Cancelled: 2n, Completed: 3n, NoShow: 4n };

// Prochaine heure alignée sur 30 minutes, au moins `hoursAhead` heures dans le futur.
async function alignedSlot(hoursAhead) {
  const target = (await time.latest()) + hoursAhead * HOUR;
  return Math.ceil(target / HALF_HOUR) * HALF_HOUR;
}

describe("BookingEscrow (assemblage)", function () {
  async function deployFixture() {
    const [admin, manager, managerB, treasury, treasuryB, staff, staffB, alice, bob, stranger] = await ethers.getSigners();
    const token = await ethers.deployContract("MockTND");
    const escrow = await ethers.deployContract("BookingEscrow", [admin.address, await token.getAddress()]);
    const escrowAddress = await escrow.getAddress();

    await escrow.setCenterManager(CENTER, manager.address);
    await escrow.setCenterManager(CENTER_B, managerB.address);
    await escrow.connect(manager).setDeposit(CENTER, DEPOSIT);
    await escrow.connect(manager).setTreasury(CENTER, treasury.address);
    await escrow.connect(manager).setStaff(CENTER, staff.address, true);
    await escrow.connect(managerB).setDeposit(CENTER_B, tnd(20));
    await escrow.connect(managerB).setTreasury(CENTER_B, treasuryB.address);
    await escrow.connect(managerB).setStaff(CENTER_B, staffB.address, true);

    for (const client of [alice, bob]) {
      await token.connect(client).faucet(START_FUNDS);
      await token.connect(client).approve(escrowAddress, ethers.MaxUint256);
    }
    return { token, escrow, escrowAddress, admin, manager, managerB, treasury, treasuryB, staff, staffB, alice, bob, stranger };
  }

  // Réservation d'alice dans 48 h au centre 1.
  async function bookedFixture() {
    const fx = await loadFixture(deployFixture);
    const start = await alignedSlot(48);
    await fx.escrow.connect(fx.alice).createBooking(CENTER, PRACTITIONER, start);
    return { ...fx, start };
  }

  // Aucun jeton créé ni perdu : le contrat détient exactement bloqué + crédité.
  async function expectBalanced({ token, escrow, escrowAddress }) {
    expect(await token.balanceOf(escrowAddress)).to.equal((await escrow.totalLocked()) + (await escrow.totalCredited()));
  }

  it("createBooking prend l'acompte du centre au client et le recopie dans la réservation", async function () {
    const fx = await loadFixture(deployFixture);
    const start = await alignedSlot(48);

    await expect(fx.escrow.connect(fx.alice).createBooking(CENTER, PRACTITIONER, start))
      .to.emit(fx.escrow, "BookingCreated")
      .withArgs(1n, fx.alice.address, CENTER, PRACTITIONER, start, DEPOSIT)
      .and.to.emit(fx.escrow, "DepositLocked")
      .withArgs(1n, CENTER, fx.alice.address, DEPOSIT);

    expect((await fx.escrow.getBooking(1n)).deposit).to.equal(DEPOSIT);
    expect((await fx.escrow.lockedDepositOf(1n)).amount).to.equal(DEPOSIT);
    expect(await fx.token.balanceOf(fx.alice.address)).to.equal(START_FUNDS - DEPOSIT);
    await expectBalanced(fx);
  });

  it("centre sans trésorerie : CenterNotConfigured (erreur du coffre)", async function () {
    const fx = await loadFixture(deployFixture);
    await fx.escrow.setDeposit(3, DEPOSIT);
    await expect(fx.escrow.connect(fx.alice).createBooking(3, PRACTITIONER, await alignedSlot(48)))
      .to.be.revertedWithCustomError(fx.escrow, "CenterNotConfigured")
      .withArgs(3);
  });

  it("jeton non approuvé ou solde insuffisant : la réservation échoue et le créneau reste libre", async function () {
    const fx = await loadFixture(deployFixture);
    const start = await alignedSlot(48);

    await fx.token.connect(fx.stranger).faucet(DEPOSIT); // solde suffisant, mais aucun approve
    await expect(fx.escrow.connect(fx.stranger).createBooking(CENTER, PRACTITIONER, start)).to.be.reverted;

    await fx.token.connect(fx.alice).transfer(fx.stranger.address, START_FUNDS - tnd(10)); // approve, mais 10 TND seulement
    await expect(fx.escrow.connect(fx.alice).createBooking(CENTER, PRACTITIONER, start)).to.be.reverted;

    expect(await fx.escrow.isSlotFree(CENTER, PRACTITIONER, start)).to.equal(true);
    expect(await fx.escrow.bookingCount()).to.equal(0n);
    await expectBalanced(fx);
  });

  describe("Scénario 1 — double réservation", function () {
    it("bob échoue (SlotAlreadyBooked), n'est pas débité, et la réservation d'alice reste Confirmed", async function () {
      const fx = await bookedFixture();

      await expect(fx.escrow.connect(fx.bob).createBooking(CENTER, PRACTITIONER, fx.start))
        .to.be.revertedWithCustomError(fx.escrow, "SlotAlreadyBooked")
        .withArgs(1n);

      expect((await fx.escrow.getBooking(1n)).status).to.equal(Status.Confirmed);
      expect((await fx.escrow.getBooking(1n)).client).to.equal(fx.alice.address);
      expect(await fx.token.balanceOf(fx.bob.address)).to.equal(START_FUNDS);
      expect(await fx.escrow.totalLocked()).to.equal(DEPOSIT);
      await expectBalanced(fx);
    });

    it("après une annulation valide, bob peut prendre le créneau libéré", async function () {
      const fx = await bookedFixture();
      await fx.escrow.connect(fx.alice).cancelBooking(1n);
      await expect(fx.escrow.connect(fx.bob).createBooking(CENTER, PRACTITIONER, fx.start)).to.emit(fx.escrow, "BookingCreated");
      expect(await fx.escrow.bookingAtSlot(CENTER, PRACTITIONER, fx.start)).to.equal(2n);
      await expectBalanced(fx);
    });
  });

  describe("Scénario 6 — compte non autorisé", function () {
    it("inconnu, staff d'un autre centre, client, gérant et administrateur ne peuvent pas valider", async function () {
      const fx = await bookedFixture();
      await time.increaseTo(fx.start + HOUR);

      for (const account of [fx.stranger, fx.staffB, fx.alice, fx.manager, fx.admin]) {
        await expect(fx.escrow.connect(account).markCompleted(1n))
          .to.be.revertedWithCustomError(fx.escrow, "NotCenterStaff")
          .withArgs(CENTER, account.address);
        await expect(fx.escrow.connect(account).markNoShow(1n))
          .to.be.revertedWithCustomError(fx.escrow, "NotCenterStaff")
          .withArgs(CENTER, account.address);
      }
      expect((await fx.escrow.getBooking(1n)).status).to.equal(Status.Confirmed);
      expect(await fx.escrow.balanceOf(fx.treasury.address)).to.equal(0n);
    });

    it("bob ne peut pas annuler la réservation d'alice : aucun jeton ne bouge", async function () {
      const fx = await bookedFixture();
      await expect(fx.escrow.connect(fx.bob).cancelBooking(1n))
        .to.be.revertedWithCustomError(fx.escrow, "NotBookingClient")
        .withArgs(1n, fx.bob.address);
      expect(await fx.escrow.balanceOf(fx.bob.address)).to.equal(0n);
      expect(await fx.escrow.balanceOf(fx.alice.address)).to.equal(0n);
      expect(await fx.escrow.isSlotFree(CENTER, PRACTITIONER, fx.start)).to.equal(false);
    });

    it("le staff du centre valide, puis la trésorerie retire l'acompte", async function () {
      const fx = await bookedFixture();
      await time.increaseTo(fx.start);
      await expect(fx.escrow.connect(fx.staff).markCompleted(1n))
        .to.emit(fx.escrow, "BookingCompleted")
        .withArgs(1n, fx.staff.address)
        .and.to.emit(fx.escrow, "DepositCredited")
        .withArgs(1n, fx.treasury.address, DEPOSIT, false);

      await fx.escrow.connect(fx.treasury).withdraw();
      expect(await fx.token.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
      await expectBalanced(fx);
    });
  });

  describe("Dates de SlotBooking + argent du coffre", function () {
    it("annulation 30 h avant : remboursée, alice retire ses 30 TND", async function () {
      const fx = await bookedFixture();
      await time.setNextBlockTimestamp(fx.start - 30 * HOUR);
      await expect(fx.escrow.connect(fx.alice).cancelBooking(1n))
        .to.emit(fx.escrow, "BookingCancelled")
        .withArgs(1n, fx.alice.address, true);
      await fx.escrow.connect(fx.alice).withdraw();
      expect(await fx.token.balanceOf(fx.alice.address)).to.equal(START_FUNDS);
      await expectBalanced(fx);
    });

    it("annulation 2 h avant : l'acompte va au salon, alice n'a rien à retirer", async function () {
      const fx = await bookedFixture();
      await time.setNextBlockTimestamp(fx.start - 2 * HOUR);
      await expect(fx.escrow.connect(fx.alice).cancelBooking(1n))
        .to.emit(fx.escrow, "BookingCancelled")
        .withArgs(1n, fx.alice.address, false);
      expect(await fx.escrow.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
      await expect(fx.escrow.connect(fx.alice).withdraw()).to.be.revertedWithCustomError(fx.escrow, "NothingToWithdraw");
    });

    it("annulation après le début refusée ; absence refusée avant 15 min, acceptée après", async function () {
      const fx = await bookedFixture();
      await time.setNextBlockTimestamp(fx.start);
      await expect(fx.escrow.connect(fx.alice).cancelBooking(1n)).to.be.revertedWithCustomError(fx.escrow, "BookingAlreadyStarted");

      await time.setNextBlockTimestamp(fx.start + 15 * 60 - 1);
      await expect(fx.escrow.connect(fx.staff).markNoShow(1n)).to.be.revertedWithCustomError(fx.escrow, "TooEarly");

      await time.setNextBlockTimestamp(fx.start + 15 * 60);
      await expect(fx.escrow.connect(fx.staff).markNoShow(1n)).to.emit(fx.escrow, "BookingNoShow");
      expect(await fx.escrow.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
      await expectBalanced(fx);
    });

    it("double règlement : InvalidStatus de SlotBooking, avant même le filet du coffre", async function () {
      const fx = await bookedFixture();
      await time.increaseTo(fx.start + HOUR);
      await fx.escrow.connect(fx.staff).markCompleted(1n);
      await expect(fx.escrow.connect(fx.staff).markNoShow(1n))
        .to.be.revertedWithCustomError(fx.escrow, "InvalidStatus")
        .withArgs(1n, Status.Completed);
      expect(await fx.escrow.balanceOf(fx.treasury.address)).to.equal(DEPOSIT);
      await expectBalanced(fx);
    });

    it("un changement de tarif après la réservation ne change ni l'acompte enregistré ni le montant réglé", async function () {
      const fx = await bookedFixture();
      await fx.escrow.connect(fx.manager).setDeposit(CENTER, tnd(50));
      await fx.escrow.connect(fx.alice).cancelBooking(1n);
      expect(await fx.escrow.balanceOf(fx.alice.address)).to.equal(DEPOSIT);
      await expectBalanced(fx);
    });
  });
});

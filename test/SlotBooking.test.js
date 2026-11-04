// Tests du Membre 1 (Module 3) : SlotBooking testé seul, avec un FAUX coffre
// (contracts/test/SlotBookingHarness.sol) à la place de DepositVault.
// Scénario 1 : double réservation. Scénario 6 : compte non autorisé. Plus les cas limites des dates et statuts.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const CENTER = 1;
const OTHER_CENTER = 2;
const PRACTITIONER = 7;
const DEPOSIT = 30_000_000n; // 30 TND, jeton à 6 décimales
const HALF_HOUR = 30 * 60;
const HOUR = 60 * 60;

const Status = { None: 0n, Confirmed: 1n, Cancelled: 2n, Completed: 3n, NoShow: 4n };

// Prochaine heure alignée sur 30 minutes, au moins `hoursAhead` heures dans le futur.
async function alignedSlot(hoursAhead) {
  const target = (await time.latest()) + hoursAhead * HOUR;
  return Math.ceil(target / HALF_HOUR) * HALF_HOUR;
}

async function deployFixture() {
  const [admin, manager, otherManager, staff, otherStaff, clientA, clientB, stranger] = await ethers.getSigners();
  const escrow = await ethers.deployContract("SlotBookingHarness", [admin.address]);

  await escrow.setCenterManager(CENTER, manager.address);
  await escrow.setCenterManager(OTHER_CENTER, otherManager.address);
  await escrow.connect(manager).setStaff(CENTER, staff.address, true);
  await escrow.connect(otherManager).setStaff(OTHER_CENTER, otherStaff.address, true);
  await escrow.connect(manager).setDeposit(CENTER, DEPOSIT);
  await escrow.connect(otherManager).setDeposit(OTHER_CENTER, DEPOSIT);

  return { escrow, admin, manager, otherManager, staff, otherStaff, clientA, clientB, stranger };
}

// Fixture avec une réservation de clientA dans 48 h.
async function bookedFixture() {
  const ctx = await loadFixture(deployFixture);
  const start = await alignedSlot(48);
  await ctx.escrow.connect(ctx.clientA).createBooking(CENTER, PRACTITIONER, start);
  return { ...ctx, start, bookingId: 1n };
}

describe("SlotBooking (Membre 1)", function () {
  describe("createBooking", function () {
    it("enregistre la réservation avec l'acompte du centre et bloque le créneau", async function () {
      const { escrow, clientA } = await loadFixture(deployFixture);
      const start = await alignedSlot(48);

      await expect(escrow.connect(clientA).createBooking(CENTER, PRACTITIONER, start))
        .to.emit(escrow, "BookingCreated")
        .withArgs(1n, clientA.address, CENTER, PRACTITIONER, start, DEPOSIT);

      const booking = await escrow.getBooking(1n);
      expect(booking.client).to.equal(clientA.address);
      expect(booking.centerId).to.equal(CENTER);
      expect(booking.practitionerId).to.equal(PRACTITIONER);
      expect(booking.startTime).to.equal(start);
      expect(booking.deposit).to.equal(DEPOSIT);
      expect(booking.status).to.equal(Status.Confirmed);
      expect(await escrow.isSlotFree(CENTER, PRACTITIONER, start)).to.equal(false);
      expect(await escrow.bookingAtSlot(CENTER, PRACTITIONER, start)).to.equal(1n);
      expect(await escrow.bookingCount()).to.equal(1n);
      expect(await escrow.lockCalls()).to.equal(1n);
      expect(await escrow.totalLocked()).to.equal(DEPOSIT);
    });

    it("fige l'acompte : un changement de tarif ne modifie pas une réservation existante", async function () {
      const { escrow, manager } = await bookedFixture();
      await escrow.connect(manager).setDeposit(CENTER, 50_000_000n);
      expect((await escrow.getBooking(1n)).deposit).to.equal(DEPOSIT);
    });

    it("refuse une heure passée ou l'heure actuelle", async function () {
      const { escrow, clientA } = await loadFixture(deployFixture);
      const past = Math.floor((await time.latest()) / HALF_HOUR) * HALF_HOUR;
      await expect(escrow.connect(clientA).createBooking(CENTER, PRACTITIONER, past))
        .to.be.revertedWithCustomError(escrow, "InvalidStartTime")
        .withArgs(past);
    });

    it("refuse une heure non alignée sur 30 minutes", async function () {
      const { escrow, clientA } = await loadFixture(deployFixture);
      const start = (await alignedSlot(48)) + 15 * 60;
      await expect(escrow.connect(clientA).createBooking(CENTER, PRACTITIONER, start))
        .to.be.revertedWithCustomError(escrow, "InvalidStartTime")
        .withArgs(start);
    });

    it("refuse un centre non configuré (acompte nul)", async function () {
      const { escrow, clientA } = await loadFixture(deployFixture);
      const start = await alignedSlot(48);
      await expect(escrow.connect(clientA).createBooking(99, PRACTITIONER, start))
        .to.be.revertedWithCustomError(escrow, "CenterNotConfigured")
        .withArgs(99);
    });

    it("laisse le créneau libre si la prise d'acompte échoue", async function () {
      const { escrow, clientA } = await loadFixture(deployFixture);
      const start = await alignedSlot(48);
      await escrow.setFailNextLock(true);
      await expect(escrow.connect(clientA).createBooking(CENTER, PRACTITIONER, start)).to.be.revertedWithCustomError(
        escrow,
        "LockFailed",
      );
      expect(await escrow.isSlotFree(CENTER, PRACTITIONER, start)).to.equal(true);
      expect(await escrow.bookingCount()).to.equal(0n);
    });
  });

  describe("Scénario 1 — double réservation", function () {
    it("le second client échoue (SlotAlreadyBooked) et la première réservation reste Confirmed", async function () {
      const { escrow, clientB, start } = await bookedFixture();

      await expect(escrow.connect(clientB).createBooking(CENTER, PRACTITIONER, start))
        .to.be.revertedWithCustomError(escrow, "SlotAlreadyBooked")
        .withArgs(1n);

      expect((await escrow.getBooking(1n)).status).to.equal(Status.Confirmed);
      expect(await escrow.bookingCount()).to.equal(1n);
      expect(await escrow.lockCalls()).to.equal(1n);
    });

    it("le même client ne peut pas non plus réserver deux fois le même créneau", async function () {
      const { escrow, clientA, start } = await bookedFixture();
      await expect(escrow.connect(clientA).createBooking(CENTER, PRACTITIONER, start)).to.be.revertedWithCustomError(
        escrow,
        "SlotAlreadyBooked",
      );
    });

    it("un autre praticien, un autre centre ou une autre heure restent réservables", async function () {
      const { escrow, clientB, start } = await bookedFixture();
      await expect(escrow.connect(clientB).createBooking(CENTER, PRACTITIONER + 1, start)).to.emit(escrow, "BookingCreated");
      await expect(escrow.connect(clientB).createBooking(OTHER_CENTER, PRACTITIONER, start)).to.emit(escrow, "BookingCreated");
      await expect(escrow.connect(clientB).createBooking(CENTER, PRACTITIONER, start + HALF_HOUR)).to.emit(
        escrow,
        "BookingCreated",
      );
    });

    it("le créneau est libéré par une annulation valide et peut être repris", async function () {
      const { escrow, clientA, clientB, start } = await bookedFixture();
      await escrow.connect(clientA).cancelBooking(1n);
      expect(await escrow.isSlotFree(CENTER, PRACTITIONER, start)).to.equal(true);

      await expect(escrow.connect(clientB).createBooking(CENTER, PRACTITIONER, start))
        .to.emit(escrow, "BookingCreated")
        .withArgs(2n, clientB.address, CENTER, PRACTITIONER, start, DEPOSIT);
      expect((await escrow.getBooking(1n)).status).to.equal(Status.Cancelled);
    });
  });

  describe("cancelBooking", function () {
    it("24 h ou plus avant : remboursé (le coffre décide, SlotBooking relaie l'indicateur)", async function () {
      const { escrow, clientA } = await bookedFixture();
      await expect(escrow.connect(clientA).cancelBooking(1n))
        .to.emit(escrow, "BookingCancelled")
        .withArgs(1n, clientA.address, true);
      expect(await escrow.refundedTotal()).to.equal(DEPOSIT);
    });

    it("à 24 h pile : remboursé ; à 1 seconde de moins : crédité au salon", async function () {
      const { escrow, clientA, clientB } = await loadFixture(deployFixture);
      const start = await alignedSlot(48);
      await escrow.connect(clientA).createBooking(CENTER, PRACTITIONER, start);
      await escrow.connect(clientB).createBooking(CENTER, PRACTITIONER + 1, start);

      await time.setNextBlockTimestamp(start - 24 * HOUR);
      await expect(escrow.connect(clientA).cancelBooking(1n)).to.emit(escrow, "BookingCancelled").withArgs(1n, clientA.address, true);

      await time.setNextBlockTimestamp(start - 24 * HOUR + 1);
      await expect(escrow.connect(clientB).cancelBooking(2n)).to.emit(escrow, "BookingCancelled").withArgs(2n, clientB.address, false);
      expect(await escrow.salonTotal()).to.equal(DEPOSIT);
    });

    it("refuse l'annulation à partir de l'heure de début", async function () {
      const { escrow, clientA, start } = await bookedFixture();
      await time.increaseTo(start);
      await expect(escrow.connect(clientA).cancelBooking(1n))
        .to.be.revertedWithCustomError(escrow, "BookingAlreadyStarted")
        .withArgs(1n);
    });

    it("refuse une réservation inexistante", async function () {
      const { escrow, clientA } = await loadFixture(deployFixture);
      await expect(escrow.connect(clientA).cancelBooking(42n))
        .to.be.revertedWithCustomError(escrow, "BookingNotFound")
        .withArgs(42n);
    });
  });

  describe("Double règlement — tout statut autre que Confirmed est définitif", function () {
    it("annulation répétée refusée (InvalidStatus)", async function () {
      const { escrow, clientA } = await bookedFixture();
      await escrow.connect(clientA).cancelBooking(1n);
      await expect(escrow.connect(clientA).cancelBooking(1n))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(1n, Status.Cancelled);
      expect(await escrow.cancelSettlements()).to.equal(1n);
    });

    it("validation répétée, ou absence après validation, refusées", async function () {
      const { escrow, staff, start } = await bookedFixture();
      await time.increaseTo(start + 20 * 60);
      await escrow.connect(staff).markCompleted(1n);
      await expect(escrow.connect(staff).markCompleted(1n))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(1n, Status.Completed);
      await expect(escrow.connect(staff).markNoShow(1n))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(1n, Status.Completed);
      expect(await escrow.salonSettlements()).to.equal(1n);
    });

    it("absence répétée, ou validation après absence, refusées", async function () {
      const { escrow, staff, start } = await bookedFixture();
      await time.increaseTo(start + 15 * 60);
      await escrow.connect(staff).markNoShow(1n);
      await expect(escrow.connect(staff).markNoShow(1n)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await expect(escrow.connect(staff).markCompleted(1n)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      expect(await escrow.salonSettlements()).to.equal(1n);
    });

    it("une réservation annulée ne peut plus être validée ni marquée absente", async function () {
      const { escrow, clientA, staff, start } = await bookedFixture();
      await escrow.connect(clientA).cancelBooking(1n);
      await time.increaseTo(start + HOUR);
      await expect(escrow.connect(staff).markCompleted(1n)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await expect(escrow.connect(staff).markNoShow(1n)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  describe("markCompleted / markNoShow — contrôles de date", function () {
    it("validation refusée avant l'heure de début, acceptée à l'heure de début", async function () {
      const { escrow, staff, start } = await bookedFixture();
      await time.setNextBlockTimestamp(start - 1);
      await expect(escrow.connect(staff).markCompleted(1n))
        .to.be.revertedWithCustomError(escrow, "TooEarly")
        .withArgs(1n, start);

      await time.setNextBlockTimestamp(start);
      await expect(escrow.connect(staff).markCompleted(1n)).to.emit(escrow, "BookingCompleted").withArgs(1n, staff.address);
      expect((await escrow.getBooking(1n)).status).to.equal(Status.Completed);
      expect(await escrow.salonTotal()).to.equal(DEPOSIT);
    });

    it("absence refusée avant 15 minutes, acceptée à 15 minutes", async function () {
      const { escrow, staff, start } = await bookedFixture();
      const allowedFrom = start + 15 * 60;
      await time.setNextBlockTimestamp(allowedFrom - 1);
      await expect(escrow.connect(staff).markNoShow(1n))
        .to.be.revertedWithCustomError(escrow, "TooEarly")
        .withArgs(1n, allowedFrom);

      await time.setNextBlockTimestamp(allowedFrom);
      await expect(escrow.connect(staff).markNoShow(1n)).to.emit(escrow, "BookingNoShow").withArgs(1n, staff.address);
      expect((await escrow.getBooking(1n)).status).to.equal(Status.NoShow);
    });

    it("le contrat garde exactement les acomptes non réglés", async function () {
      const { escrow, clientA, clientB, staff } = await loadFixture(deployFixture);
      const start = await alignedSlot(48);
      await escrow.connect(clientA).createBooking(CENTER, PRACTITIONER, start);
      await escrow.connect(clientB).createBooking(CENTER, PRACTITIONER + 1, start);
      expect(await escrow.totalLocked()).to.equal(2n * DEPOSIT);
      await time.increaseTo(start);
      await escrow.connect(staff).markCompleted(1n);
      expect(await escrow.totalLocked()).to.equal(DEPOSIT);
    });
  });

  describe("Scénario 6 — compte non autorisé", function () {
    it("un inconnu ne peut ni valider ni marquer une absence", async function () {
      const { escrow, stranger, start } = await bookedFixture();
      await time.increaseTo(start + HOUR);
      await expect(escrow.connect(stranger).markCompleted(1n))
        .to.be.revertedWithCustomError(escrow, "NotCenterStaff")
        .withArgs(CENTER, stranger.address);
      await expect(escrow.connect(stranger).markNoShow(1n))
        .to.be.revertedWithCustomError(escrow, "NotCenterStaff")
        .withArgs(CENTER, stranger.address);
    });

    it("le staff d'un autre centre ne peut ni valider ni marquer une absence", async function () {
      const { escrow, otherStaff, start } = await bookedFixture();
      await time.increaseTo(start + HOUR);
      await expect(escrow.connect(otherStaff).markCompleted(1n))
        .to.be.revertedWithCustomError(escrow, "NotCenterStaff")
        .withArgs(CENTER, otherStaff.address);
      await expect(escrow.connect(otherStaff).markNoShow(1n)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");
    });

    it("le client lui-même ne peut ni valider ni marquer une absence", async function () {
      const { escrow, clientA, start } = await bookedFixture();
      await time.increaseTo(start + HOUR);
      await expect(escrow.connect(clientA).markCompleted(1n)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");
      await expect(escrow.connect(clientA).markNoShow(1n)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");
    });

    it("ni l'administrateur ni le gérant ne valident sans être nommés staff", async function () {
      const { escrow, admin, manager, start } = await bookedFixture();
      await time.increaseTo(start + HOUR);
      await expect(escrow.connect(admin).markCompleted(1n)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");
      await expect(escrow.connect(manager).markNoShow(1n)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");

      // Le gérant se nomme lui-même staff (cahier des charges §3), puis peut valider.
      await escrow.connect(manager).setStaff(CENTER, manager.address, true);
      await expect(escrow.connect(manager).markCompleted(1n)).to.emit(escrow, "BookingCompleted");
    });

    it("un staff retiré perd aussitôt ses droits", async function () {
      const { escrow, manager, staff, start } = await bookedFixture();
      await escrow.connect(manager).setStaff(CENTER, staff.address, false);
      await time.increaseTo(start + HOUR);
      await expect(escrow.connect(staff).markCompleted(1n)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");
    });

    it("un autre client ne peut pas annuler la réservation d'autrui, qui reste Confirmed", async function () {
      const { escrow, clientB, start } = await bookedFixture();
      await expect(escrow.connect(clientB).cancelBooking(1n))
        .to.be.revertedWithCustomError(escrow, "NotBookingClient")
        .withArgs(1n, clientB.address);
      expect((await escrow.getBooking(1n)).status).to.equal(Status.Confirmed);
      expect(await escrow.isSlotFree(CENTER, PRACTITIONER, start)).to.equal(false);
    });

    it("le staff du centre ne peut pas annuler à la place du client", async function () {
      const { escrow, staff } = await bookedFixture();
      await expect(escrow.connect(staff).cancelBooking(1n)).to.be.revertedWithCustomError(escrow, "NotBookingClient");
    });

    it("seul l'administrateur nomme un gérant", async function () {
      const { escrow, manager, stranger } = await loadFixture(deployFixture);
      await expect(escrow.connect(manager).setCenterManager(CENTER, stranger.address))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
        .withArgs(manager.address);
      expect(await escrow.managerOf(CENTER)).to.equal(manager.address);
    });

    it("seuls l'administrateur et le gérant du centre nomment le staff de ce centre", async function () {
      const { escrow, admin, otherManager, staff, stranger } = await loadFixture(deployFixture);
      await expect(escrow.connect(otherManager).setStaff(CENTER, stranger.address, true))
        .to.be.revertedWithCustomError(escrow, "NotCenterManager")
        .withArgs(CENTER, otherManager.address);
      await expect(escrow.connect(staff).setStaff(CENTER, stranger.address, true)).to.be.revertedWithCustomError(
        escrow,
        "NotCenterManager",
      );
      await expect(escrow.connect(admin).setStaff(CENTER, stranger.address, true))
        .to.emit(escrow, "StaffSet")
        .withArgs(CENTER, stranger.address, true);
    });

    it("adresse nulle refusée pour un gérant ou un staff", async function () {
      const { escrow, manager } = await loadFixture(deployFixture);
      await expect(escrow.setCenterManager(CENTER, ethers.ZeroAddress)).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(escrow.connect(manager).setStaff(CENTER, ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        escrow,
        "ZeroAddress",
      );
    });
  });

  describe("Lectures", function () {
    it("getBooking renvoie le statut None pour un identifiant inconnu ; isSlotFree vrai pour un créneau libre", async function () {
      const { escrow } = await loadFixture(deployFixture);
      expect((await escrow.getBooking(5n)).status).to.equal(Status.None);
      expect(await escrow.isSlotFree(CENTER, PRACTITIONER, await alignedSlot(48))).to.equal(true);
    });
  });
});

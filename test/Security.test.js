// TESTS DE VULNÉRABILITÉS — BookingEscrow assemblé (SlotBooking + DepositVault) avec le vrai MockTND.
// Chaque bloc simule une ATTAQUE connue des smart contracts et vérifie que le contrat y résiste :
//   1. Contrôle d'accès / élévation de privilèges      5. Manipulation du temps (bornes exactes)
//   2. Front-running sur un même créneau                6. Dépassement d'entier et montants extrêmes
//   3. Falsification du montant de l'acompte            7. Jetons envoyés de force (« donation »)
//   4. Rejeu / double règlement / vol de solde          8. Fuzzing : invariant comptable sur 300 actions aléatoires
// (La réentrance et les jetons non conformes sont testés dans DepositVault.test.js avec des jetons hostiles.)
//
// Lancer : npm test -- test/Security.test.js
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const tnd = (amount) => ethers.parseUnits(String(amount), 6);
const HOUR = 3600;
const HALF_HOUR = 1800;
const CENTER = 1;
const CENTER_B = 2;
const PRACTITIONER = 7;
const DEPOSIT = tnd(30);
const Status = { Confirmed: 1n, Cancelled: 2n, Completed: 3n, NoShow: 4n };

async function alignedSlot(hoursAhead) {
  const target = (await time.latest()) + hoursAhead * HOUR;
  return Math.ceil(target / HALF_HOUR) * HALF_HOUR;
}

describe("Sécurité — tests de vulnérabilités", function () {
  async function deployFixture() {
    const [admin, manager, managerB, treasury, treasuryB, staff, staffB, alice, bob, mallory] = await ethers.getSigners();
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

    for (const user of [alice, bob, mallory]) {
      await token.connect(user).faucet(tnd(1000));
      await token.connect(user).approve(escrowAddress, ethers.MaxUint256);
    }
    return { token, escrow, escrowAddress, admin, manager, managerB, treasury, treasuryB, staff, staffB, alice, bob, mallory };
  }

  async function bookedFixture() {
    const fx = await loadFixture(deployFixture);
    const start = await alignedSlot(48);
    await fx.escrow.connect(fx.alice).createBooking(CENTER, PRACTITIONER, start);
    return { ...fx, start };
  }

  // Invariant : le contrat détient exactement « bloqué + crédité » (aucun jeton créé ni perdu).
  async function expectBalanced({ token, escrow, escrowAddress }) {
    expect(await token.balanceOf(escrowAddress)).to.equal((await escrow.totalLocked()) + (await escrow.totalCredited()));
  }

  // ═══════════════════════ 1. Contrôle d'accès / élévation de privilèges ═══════════════════════
  describe("1. Contrôle d'accès : chaque fonction sensible refuse les comptes non autorisés", function () {
    it("seul l'administrateur nomme un gérant (même un gérant ne peut pas s'auto-promouvoir ailleurs)", async function () {
      const { escrow, manager, mallory } = await loadFixture(deployFixture);
      for (const attacker of [mallory, manager]) {
        await expect(escrow.connect(attacker).setCenterManager(CENTER_B, attacker.address))
          .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
          .withArgs(attacker.address);
      }
    });

    it("un inconnu ou le gérant d'un AUTRE centre ne peut ni changer l'acompte, ni la trésorerie, ni le staff", async function () {
      const { escrow, managerB, mallory } = await loadFixture(deployFixture);
      for (const attacker of [mallory, managerB]) {
        await expect(escrow.connect(attacker).setDeposit(CENTER, 1n)).to.be.revertedWithCustomError(escrow, "NotCenterManager");
        await expect(escrow.connect(attacker).setTreasury(CENTER, attacker.address)).to.be.revertedWithCustomError(escrow, "NotCenterManager");
        await expect(escrow.connect(attacker).setStaff(CENTER, attacker.address, true)).to.be.revertedWithCustomError(escrow, "NotCenterManager");
      }
    });

    it("détournement de trésorerie impossible : l'acompte va toujours à la trésorerie choisie par le gérant", async function () {
      const { escrow, staff, treasury, mallory, start } = await bookedFixture();
      await expect(escrow.connect(mallory).setTreasury(CENTER, mallory.address)).to.be.reverted;
      await time.increaseTo(start);
      await escrow.connect(staff).markCompleted(1n);
      expect(await escrow.balanceOf(treasury.address)).to.equal(DEPOSIT);
      expect(await escrow.balanceOf(mallory.address)).to.equal(0n);
    });

    it("seul le staff DU centre valide une prestation ou une absence (ni client, ni gérant, ni admin, ni staff d'un autre centre)", async function () {
      const { escrow, alice, manager, admin, staffB, mallory, start } = await bookedFixture();
      await time.increaseTo(start + 20 * 60);
      for (const attacker of [alice, manager, admin, staffB, mallory]) {
        await expect(escrow.connect(attacker).markCompleted(1n)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");
        await expect(escrow.connect(attacker).markNoShow(1n)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");
      }
    });

    it("seul le client annule SA réservation", async function () {
      const { escrow, bob, staff, manager, admin } = await bookedFixture();
      for (const attacker of [bob, staff, manager, admin]) {
        await expect(escrow.connect(attacker).cancelBooking(1n))
          .to.be.revertedWithCustomError(escrow, "NotBookingClient")
          .withArgs(1n, attacker.address);
      }
    });

    it("un staff retiré perd immédiatement ses droits", async function () {
      const { escrow, manager, staff, start } = await bookedFixture();
      await escrow.connect(manager).setStaff(CENTER, staff.address, false);
      await time.increaseTo(start);
      await expect(escrow.connect(staff).markCompleted(1n)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");
    });

    it("adresses nulles refusées partout où une vraie adresse est obligatoire", async function () {
      const { escrow, manager } = await loadFixture(deployFixture);
      await expect(escrow.setCenterManager(3, ethers.ZeroAddress)).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(escrow.connect(manager).setTreasury(CENTER, ethers.ZeroAddress)).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(escrow.connect(manager).setStaff(CENTER, ethers.ZeroAddress, true)).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(ethers.deployContract("BookingEscrow", [manager.address, ethers.ZeroAddress])).to.be.reverted;
    });
  });

  // ═══════════════════════ 2. Front-running ═══════════════════════
  describe("2. Front-running : deux transactions visent le même créneau dans le même bloc", function () {
    it("une seule réservation passe ; l'autre est annulée sans perdre d'argent", async function () {
      const { token, escrow, alice, mallory, escrowAddress } = await loadFixture(deployFixture);
      const start = await alignedSlot(48);
      const before = await token.balanceOf(alice.address);

      // Mallory voit la transaction d'Alice dans la mempool et envoie la même avec plus de gaz.
      await network.provider.send("evm_setAutomine", [false]);
      const victim = await escrow.connect(alice).createBooking(CENTER, PRACTITIONER, start, { gasPrice: ethers.parseUnits("1", "gwei") });
      const attack = await escrow.connect(mallory).createBooking(CENTER, PRACTITIONER, start, { gasPrice: ethers.parseUnits("50", "gwei") });
      await network.provider.send("evm_mine");
      await network.provider.send("evm_setAutomine", [true]);

      const results = await Promise.allSettled([victim.wait(), attack.wait()]);
      expect(results.filter((r) => r.status === "fulfilled")).to.have.length(1);
      expect(await escrow.bookingCount()).to.equal(1n);
      expect((await escrow.getBooking(1n)).client).to.equal(mallory.address); // le plus offrant passe en premier
      // La victime n'a payé que le gaz : son acompte n'a pas été pris.
      expect(await token.balanceOf(alice.address)).to.equal(before);
      await expectBalanced({ token, escrow, escrowAddress });
    });

    it("un créneau libéré par annulation se réserve à nouveau ; un créneau pris reste protégé", async function () {
      const { escrow, alice, bob, start } = await bookedFixture();
      await expect(escrow.connect(bob).createBooking(CENTER, PRACTITIONER, start))
        .to.be.revertedWithCustomError(escrow, "SlotAlreadyBooked")
        .withArgs(1n);
      await escrow.connect(alice).cancelBooking(1n);
      await expect(escrow.connect(bob).createBooking(CENTER, PRACTITIONER, start)).to.emit(escrow, "BookingCreated");
    });
  });

  // ═══════════════════════ 3. Falsification de l'acompte ═══════════════════════
  describe("3. Le client ne choisit jamais le montant de l'acompte", function () {
    it("createBooking n'a pas de paramètre montant : c'est toujours l'acompte du centre qui est pris", async function () {
      const { escrow } = await loadFixture(deployFixture);
      const fragment = escrow.interface.getFunction("createBooking");
      expect(fragment.inputs.map((i) => i.name)).to.deep.equal(["centerId", "practitionerId", "startTime"]);
    });

    it("le gérant qui augmente l'acompte APRÈS la réservation ne touche pas aux réservations existantes", async function () {
      const { escrow, manager, alice, treasury, staff, start } = await bookedFixture();
      await escrow.connect(manager).setDeposit(CENTER, tnd(500));
      await time.increaseTo(start);
      await escrow.connect(staff).markCompleted(1n);
      expect(await escrow.balanceOf(treasury.address)).to.equal(DEPOSIT); // 30 TND, pas 500
      expect((await escrow.getBooking(1n)).client).to.equal(alice.address);
    });

    it("acompte nul refusé (pas de réservation gratuite qui bloquerait les créneaux)", async function () {
      const { escrow, manager } = await loadFixture(deployFixture);
      await expect(escrow.connect(manager).setDeposit(CENTER, 0n)).to.be.revertedWithCustomError(escrow, "InvalidDepositAmount");
    });
  });

  // ═══════════════════════ 4. Rejeu / double règlement / vol ═══════════════════════
  describe("4. Rejeu et double dépense", function () {
    it("une réservation n'est réglée qu'une fois, quel que soit l'enchaînement d'appels", async function () {
      const { escrow, alice, staff, start } = await bookedFixture();
      await escrow.connect(alice).cancelBooking(1n);
      await time.increaseTo(start + 20 * 60);
      await expect(escrow.connect(alice).cancelBooking(1n)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await expect(escrow.connect(staff).markCompleted(1n)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await expect(escrow.connect(staff).markNoShow(1n)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("un retrait ne se rejoue pas ; personne ne peut retirer le solde d'un autre", async function () {
      const { token, escrow, alice, mallory, escrowAddress } = await bookedFixture();
      await escrow.connect(alice).cancelBooking(1n); // > 24 h : remboursée
      await expect(escrow.connect(mallory).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
      await escrow.connect(alice).withdraw();
      await expect(escrow.connect(alice).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
      await expectBalanced({ token, escrow, escrowAddress });
    });

    it("identifiant de réservation inventé : refusé", async function () {
      const { escrow, alice, staff } = await loadFixture(deployFixture);
      await expect(escrow.connect(alice).cancelBooking(999n)).to.be.revertedWithCustomError(escrow, "BookingNotFound");
      await expect(escrow.connect(staff).markCompleted(999n)).to.be.revertedWithCustomError(escrow, "BookingNotFound");
    });
  });

  // ═══════════════════════ 5. Manipulation du temps ═══════════════════════
  describe("5. Horodatage : les bornes sont exactes (un mineur ne gagne rien à quelques secondes près)", function () {
    it("annulation à 24 h pile : remboursée ; une seconde plus tard : acquise au salon", async function () {
      const fx = await loadFixture(deployFixture);
      const start = await alignedSlot(72);
      await fx.escrow.connect(fx.alice).createBooking(CENTER, PRACTITIONER, start);
      await fx.escrow.connect(fx.bob).createBooking(CENTER, PRACTITIONER + 1, start);

      await time.setNextBlockTimestamp(start - 24 * HOUR);
      await expect(fx.escrow.connect(fx.alice).cancelBooking(1n)).to.emit(fx.escrow, "BookingCancelled").withArgs(1n, fx.alice.address, true);
      await time.setNextBlockTimestamp(start - 24 * HOUR + 1);
      await expect(fx.escrow.connect(fx.bob).cancelBooking(2n)).to.emit(fx.escrow, "BookingCancelled").withArgs(2n, fx.bob.address, false);
    });

    it("absence marquée trop tôt (avant début + 15 min) : refusée", async function () {
      const { escrow, staff, start } = await bookedFixture();
      await time.setNextBlockTimestamp(start + 15 * 60 - 1);
      await expect(escrow.connect(staff).markNoShow(1n)).to.be.revertedWithCustomError(escrow, "TooEarly");
      await time.setNextBlockTimestamp(start + 15 * 60);
      await expect(escrow.connect(staff).markNoShow(1n)).to.emit(escrow, "BookingNoShow");
    });

    it("réservation dans le passé ou non alignée sur 30 min : refusée ; annulation après le début : refusée", async function () {
      const { escrow, alice, start } = await bookedFixture();
      const now = await time.latest();
      await expect(escrow.connect(alice).createBooking(CENTER, PRACTITIONER, now - (now % HALF_HOUR))).to.be.revertedWithCustomError(escrow, "InvalidStartTime");
      await expect(escrow.connect(alice).createBooking(CENTER, PRACTITIONER, start + 60)).to.be.revertedWithCustomError(escrow, "InvalidStartTime");
      await time.increaseTo(start);
      await expect(escrow.connect(alice).cancelBooking(1n)).to.be.revertedWithCustomError(escrow, "BookingAlreadyStarted");
    });
  });

  // ═══════════════════════ 6. Dépassement d'entier / montants extrêmes ═══════════════════════
  describe("6. Dépassement d'entier et montants extrêmes", function () {
    it("acompte gigantesque (2^256 − 1) : la réservation échoue proprement, rien n'est bloqué", async function () {
      const { token, escrow, manager, alice, escrowAddress } = await loadFixture(deployFixture);
      await escrow.connect(manager).setDeposit(CENTER, ethers.MaxUint256);
      await expect(escrow.connect(alice).createBooking(CENTER, PRACTITIONER, await alignedSlot(48))).to.be.reverted;
      expect(await escrow.bookingCount()).to.equal(0n);
      expect(await escrow.totalLocked()).to.equal(0n);
      await expectBalanced({ token, escrow, escrowAddress });
    });

    it("identifiants maximaux (uint32 / uint64) acceptés sans collision de créneau", async function () {
      const { escrow, alice, bob } = await loadFixture(deployFixture);
      const start = await alignedSlot(48);
      await escrow.connect(alice).createBooking(CENTER, 2 ** 32 - 1, start);
      // Même horaire, autre praticien : clé différente (abi.encode, pas encodePacked).
      await escrow.connect(bob).createBooking(CENTER, 2 ** 32 - 2, start);
      expect(await escrow.bookingCount()).to.equal(2n);
    });

    it("faucet du jeton de test plafonné à 1 000 TND par appel", async function () {
      const { token, mallory } = await loadFixture(deployFixture);
      await expect(token.connect(mallory).faucet(tnd(1000) + 1n)).to.be.revertedWithCustomError(token, "FaucetAmountTooHigh");
    });
  });

  // ═══════════════════════ 7. Jetons envoyés de force ═══════════════════════
  describe("7. « Donation » : des jetons envoyés directement au contrat ne cassent rien", function () {
    it("la comptabilité interne ne dépend pas du solde réel : personne ne peut retirer plus que son dû", async function () {
      const { token, escrow, escrowAddress, alice, mallory, staff, treasury, start } = await bookedFixture();
      await token.connect(mallory).transfer(escrowAddress, tnd(500)); // tentative de fausser les comptes
      expect(await token.balanceOf(escrowAddress)).to.equal(DEPOSIT + tnd(500));
      expect(await escrow.totalLocked()).to.equal(DEPOSIT); // inchangé
      await expect(escrow.connect(mallory).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");

      await time.increaseTo(start);
      await escrow.connect(staff).markCompleted(1n);
      await escrow.connect(treasury).withdraw();
      expect(await token.balanceOf(treasury.address)).to.equal(DEPOSIT); // ni plus ni moins
      expect(await escrow.balanceOf(alice.address)).to.equal(0n);
    });
  });

  // ═══════════════════════ 8. Fuzzing de l'invariant comptable ═══════════════════════
  describe("8. Fuzzing : 300 actions aléatoires, l'invariant comptable tient à chaque étape", function () {
    it("balanceOf(contrat) == totalLocked + totalCredited et Σ soldes == totalCredited", async function () {
      this.timeout(120_000);
      const fx = await loadFixture(deployFixture);
      const { token, escrow, staff, staffB, alice, bob, mallory, treasury, treasuryB } = fx;
      const clients = [alice, bob, mallory];
      const beneficiaries = [alice, bob, mallory, treasury, treasuryB];
      // Générateur pseudo-aléatoire déterministe (même graine = même scénario rejouable).
      let seed = 20261111;
      const rand = (n) => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % n;
      };
      const open = [];
      let counts = { book: 0, cancel: 0, settle: 0, withdraw: 0, failed: 0 };

      for (let step = 0; step < 300; step++) {
        const action = rand(5);
        try {
          if (action <= 1) {
            const center = rand(2) === 0 ? CENTER : CENTER_B;
            const start = await alignedSlot(1 + rand(96));
            const client = clients[rand(3)];
            await escrow.connect(client).createBooking(center, rand(4), start);
            open.push(await escrow.bookingCount());
            counts.book++;
          } else if (action === 2 && open.length) {
            const id = open.splice(rand(open.length), 1)[0];
            const b = await escrow.getBooking(id);
            const client = clients.find((c) => c.address === b.client);
            await escrow.connect(client).cancelBooking(id);
            counts.cancel++;
          } else if (action === 3 && open.length) {
            const id = open[rand(open.length)];
            const b = await escrow.getBooking(id);
            await time.increaseTo(Math.max(Number(b.startTime) + 15 * 60, (await time.latest()) + 1));
            const s = Number(b.centerId) === CENTER ? staff : staffB;
            await (rand(2) ? escrow.connect(s).markCompleted(id) : escrow.connect(s).markNoShow(id));
            open.splice(open.indexOf(id), 1);
            counts.settle++;
          } else {
            const who = beneficiaries[rand(beneficiaries.length)];
            if ((await escrow.balanceOf(who.address)) > 0n) {
              await escrow.connect(who).withdraw();
              counts.withdraw++;
            }
          }
        } catch {
          counts.failed++; // refus attendu (créneau pris, réservation déjà commencée…) : l'invariant doit tenir quand même
          for (const id of [...open]) if ((await escrow.getBooking(id)).status !== Status.Confirmed) open.splice(open.indexOf(id), 1);
        }
        await expectBalanced(fx);
        let sum = 0n;
        for (const b of beneficiaries) sum += await escrow.balanceOf(b.address);
        expect(sum).to.equal(await escrow.totalCredited());
      }
      // Le scénario a réellement exercé toutes les branches.
      expect(counts.book).to.be.greaterThan(20);
      expect(counts.cancel + counts.settle).to.be.greaterThan(10);
      expect(counts.withdraw).to.be.greaterThan(3);
      void token;
    });
  });
});

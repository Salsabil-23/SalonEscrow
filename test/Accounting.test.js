// Cohérence comptable et cas limites de DepositVault (Membre 2).
// Cahier §10 : « Aucun jeton n'est perdu ni créé : le contrat détient exactement la somme des acomptes bloqués et des soldes. »
// Lancer : npm test -- test/Accounting.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const tnd = (amount) => ethers.parseUnits(String(amount), 6);
const HOUR = 3600n;
const CENTERS = [1, 2];

describe("Cohérence comptable", function () {
  async function deployFixture() {
    const signers = await ethers.getSigners();
    const [admin, managerA, managerB, treasuryA, treasuryB, treasuryA2, alice, bob, carol, stranger] = signers;
    const token = await ethers.deployContract("MockTND");
    const vault = await ethers.deployContract("VaultHarness", [admin.address, await token.getAddress()]);
    const vaultAddress = await vault.getAddress();

    await vault.setCenterManager(1, managerA.address);
    await vault.setCenterManager(2, managerB.address);
    await vault.connect(managerA).setDeposit(1, tnd(30));
    await vault.connect(managerA).setTreasury(1, treasuryA.address);
    await vault.connect(managerB).setDeposit(2, tnd(20));
    await vault.connect(managerB).setTreasury(2, treasuryB.address);

    const clients = [alice, bob, carol];
    for (const c of clients) {
      await token.connect(c).faucet(tnd(1000));
      await token.connect(c).approve(vaultAddress, ethers.MaxUint256);
    }
    return { token, vault, vaultAddress, admin, managerA, managerB, treasuryA, treasuryB, treasuryA2, alice, bob, carol, stranger, clients };
  }

  async function cancelBefore(vault, bookingId, before) {
    const now = BigInt(await time.latest()) + 1n;
    await time.setNextBlockTimestamp(now);
    return vault.cancel(bookingId, now + before);
  }

  describe("Cas limites", function () {
    it("isolation des centres : un acompte du centre B ne va qu'à la trésorerie B, au tarif B", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, 2);
      await fx.vault.settleToSalon(1);
      expect(await fx.vault.balanceOf(fx.treasuryB.address)).to.equal(tnd(20));
      expect(await fx.vault.balanceOf(fx.treasuryA.address)).to.equal(0n);
    });

    it("une même adresse cliente et trésorerie : les crédits s'additionnent, un seul retrait prend tout", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.managerA).setTreasury(1, fx.alice.address);
      await fx.vault.connect(fx.alice).book(1, 1);
      await fx.vault.connect(fx.bob).book(2, 1);
      await cancelBefore(fx.vault, 1, 30n * HOUR); // remboursée en tant que cliente
      await fx.vault.settleToSalon(2); // créditée en tant que trésorerie
      expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(tnd(60));
      await expect(fx.vault.connect(fx.alice).withdraw()).to.changeTokenBalance(fx.token, fx.alice, tnd(60));
    });

    it("jetons envoyés directement au coffre : ils ne sont crédités à personne et n'altèrent aucun solde", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.alice).book(1, 1);
      await fx.token.connect(fx.bob).transfer(fx.vaultAddress, tnd(5)); // « don » hors réservation
      const held = await fx.token.balanceOf(fx.vaultAddress);
      const accounted = (await fx.vault.totalLocked()) + (await fx.vault.totalCredited());
      expect(held - accounted).to.equal(tnd(5)); // excédent bloqué (documenté dans DepositVault)
      await expect(fx.vault.connect(fx.bob).withdraw()).to.be.revertedWithCustomError(fx.vault, "NothingToWithdraw");
      await fx.vault.settleToSalon(1);
      await fx.vault.connect(fx.treasuryA).withdraw();
      expect(await fx.token.balanceOf(fx.vaultAddress)).to.equal(tnd(5));
    });

    it("plusieurs réservations du même client, issues différentes : chaque acompte suit sa propre règle", async function () {
      const fx = await loadFixture(deployFixture);
      for (const id of [1, 2, 3]) await fx.vault.connect(fx.carol).book(id, 1);
      await cancelBefore(fx.vault, 1, 25n * HOUR); // remboursé
      await cancelBefore(fx.vault, 2, 23n * HOUR); // salon
      await fx.vault.settleToSalon(3); // salon
      expect(await fx.vault.balanceOf(fx.carol.address)).to.equal(tnd(30));
      expect(await fx.vault.balanceOf(fx.treasuryA.address)).to.equal(tnd(60));
    });

    it("le plus grand acompte possible (plafond du faucet) passe sans débordement", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.managerA).setDeposit(1, tnd(1000));
      await fx.vault.connect(fx.alice).book(1, 1);
      await cancelBefore(fx.vault, 1, 48n * HOUR);
      await fx.vault.connect(fx.alice).withdraw();
      expect(await fx.token.balanceOf(fx.alice.address)).to.equal(tnd(1000));
    });

    it("un acompte d'une seule unité (0,000001 TND) est géré au même titre", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.vault.connect(fx.managerA).setDeposit(1, 1n);
      await fx.vault.connect(fx.alice).book(1, 1);
      await fx.vault.settleToSalon(1);
      await expect(fx.vault.connect(fx.treasuryA).withdraw()).to.changeTokenBalance(fx.token, fx.treasuryA, 1n);
    });
  });

  // ═════════════════════ Test fondé sur un modèle, séquence pseudo-aléatoire ═════════════════════
  // On rejoue une longue séquence d'opérations tirées au hasard (graine fixe : résultat reproductible) et on compare,
  // après CHAQUE opération, l'état du contrat à un modèle JavaScript simple de ce qu'il devrait être.
  describe("Séquence aléatoire (modèle de référence)", function () {
    it("200 opérations : soldes, bloqué, crédité et jetons détenus restent exacts", async function () {
      this.timeout(180_000);
      const fx = await loadFixture(deployFixture);
      const { token, vault, vaultAddress, clients } = fx;

      // Générateur pseudo-aléatoire mulberry32 à graine fixe (même séquence à chaque exécution).
      // Math.imul garde des entiers 32 bits exacts (une multiplication naïve dépasserait la précision des nombres JS).
      let seed = 20261104;
      const rand = (n) => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) % n;
      };
      const pick = (arr) => arr[rand(arr.length)];

      // Modèle de référence
      const model = {
        deposits: { 1: tnd(30), 2: tnd(20) },
        treasuries: { 1: fx.treasuryA.address, 2: fx.treasuryB.address },
        locked: new Map(), // bookingId -> { center, client, amount }
        settled: new Set(),
        balances: new Map(), // adresse -> solde
      };
      const credit = (addr, amount) => model.balances.set(addr, (model.balances.get(addr) ?? 0n) + amount);
      const balanceOf = (addr) => model.balances.get(addr) ?? 0n;

      const participants = [...clients, fx.treasuryA, fx.treasuryB, fx.treasuryA2];
      const managers = { 1: fx.managerA, 2: fx.managerB };
      const offsets = [48n * HOUR, 25n * HOUR, 24n * HOUR, 24n * HOUR - 1n, 2n * HOUR, 60n];
      let nextId = 1;
      const counts = {};

      for (let step = 0; step < 200; step++) {
        const op = pick(["book", "book", "book", "cancel", "salon", "withdraw", "withdraw", "setDeposit", "setTreasury", "resettle"]);
        counts[op] = (counts[op] ?? 0) + 1;

        if (op === "book") {
          const client = pick(clients);
          const center = pick(CENTERS);
          const amount = model.deposits[center];
          const id = nextId++;
          if ((await token.balanceOf(client.address)) < amount) {
            await expect(vault.connect(client).book(id, center)).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
          } else {
            await vault.connect(client).book(id, center);
            model.locked.set(id, { center, client: client.address, amount });
          }
        } else if (op === "cancel" || op === "salon") {
          if (model.locked.size === 0) continue;
          const id = pick([...model.locked.keys()]);
          const d = model.locked.get(id);
          if (op === "cancel") {
            const before = pick(offsets);
            await cancelBefore(vault, id, before);
            credit(before >= 24n * HOUR ? d.client : model.treasuries[d.center], d.amount);
          } else {
            await vault.settleToSalon(id);
            credit(model.treasuries[d.center], d.amount);
          }
          model.locked.delete(id);
          model.settled.add(id);
        } else if (op === "withdraw") {
          const who = pick(participants);
          const expected = balanceOf(who.address);
          if (expected === 0n) {
            await expect(vault.connect(who).withdraw()).to.be.revertedWithCustomError(vault, "NothingToWithdraw");
          } else {
            await expect(vault.connect(who).withdraw()).to.changeTokenBalance(token, who, expected);
            model.balances.set(who.address, 0n);
          }
        } else if (op === "setDeposit") {
          const center = pick(CENTERS);
          const amount = tnd(1 + rand(60));
          await vault.connect(managers[center]).setDeposit(center, amount);
          model.deposits[center] = amount;
        } else if (op === "setTreasury") {
          const next = model.treasuries[1] === fx.treasuryA.address ? fx.treasuryA2 : fx.treasuryA;
          await vault.connect(fx.managerA).setTreasury(1, next.address);
          model.treasuries[1] = next.address;
        } else if (op === "resettle") {
          if (model.settled.size === 0) continue;
          const id = pick([...model.settled]);
          await expect(vault.settleToSalon(id)).to.be.revertedWithCustomError(vault, "DepositNotLocked");
        }

        // ── Vérifications après chaque opération ──
        let expectedLocked = 0n;
        for (const d of model.locked.values()) expectedLocked += d.amount;
        let expectedCredited = 0n;
        for (const v of model.balances.values()) expectedCredited += v;

        expect(await vault.totalLocked(), `bloqué, étape ${step} (${op})`).to.equal(expectedLocked);
        expect(await vault.totalCredited(), `crédité, étape ${step} (${op})`).to.equal(expectedCredited);
        expect(await token.balanceOf(vaultAddress), `détenu, étape ${step} (${op})`).to.equal(expectedLocked + expectedCredited);
        for (const p of participants) {
          expect(await vault.balanceOf(p.address), `solde de ${p.address}, étape ${step}`).to.equal(balanceOf(p.address));
        }
      }

      // Conservation : tous les jetons créés sont soit dans un wallet participant, soit dans le coffre.
      let inWallets = 0n;
      for (const p of participants) inWallets += await token.balanceOf(p.address);
      expect(inWallets + (await token.balanceOf(vaultAddress))).to.equal(await token.totalSupply());

      // La séquence a bien exercé chaque type d'opération.
      for (const op of ["book", "cancel", "salon", "withdraw", "setDeposit", "setTreasury", "resettle"]) {
        expect(counts[op] ?? 0, `opération ${op} jamais tirée`).to.be.greaterThan(0);
      }
    });
  });
});

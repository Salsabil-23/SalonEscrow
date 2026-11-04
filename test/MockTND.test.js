// Tests du jeton de test MockTND (Membre 2).
// Lancer : npm test -- test/MockTND.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// 6 décimales : tnd(30) === 30_000_000n
const tnd = (amount) => ethers.parseUnits(String(amount), 6);

describe("MockTND", function () {
  // Une fixture est exécutée une fois, puis Hardhat restaure cet état (snapshot) avant chaque test.
  async function deployFixture() {
    const [deployer, alice, bob, spender] = await ethers.getSigners();
    const token = await ethers.deployContract("MockTND");
    return { token, deployer, alice, bob, spender };
  }

  describe("Déploiement et métadonnées", function () {
    it("a le nom et le symbole MockTND", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("MockTND");
      expect(await token.symbol()).to.equal("MockTND");
    });

    it("a 6 décimales : 30 TND = 30 000 000 unités", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.decimals()).to.equal(6n);
      expect(tnd(30)).to.equal(30_000_000n);
    });

    it("démarre sans aucun jeton en circulation (pas de prémine)", async function () {
      const { token, deployer } = await loadFixture(deployFixture);
      expect(await token.totalSupply()).to.equal(0n);
      expect(await token.balanceOf(deployer.address)).to.equal(0n);
    });

    it("expose un plafond de faucet de 1 000 TND", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.MAX_FAUCET_AMOUNT()).to.equal(tnd(1000));
    });
  });

  describe("Faucet", function () {
    it("crédite l'appelant et augmente l'offre totale", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await expect(token.connect(alice).faucet(tnd(100))).to.changeTokenBalance(token, alice, tnd(100));
      expect(await token.totalSupply()).to.equal(tnd(100));
    });

    it("émet Transfer depuis l'adresse nulle", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await expect(token.connect(alice).faucet(tnd(5)))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, tnd(5));
    });

    it("accepte exactement 1 000 TND (limite incluse)", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.connect(alice).faucet(tnd(1000));
      expect(await token.balanceOf(alice.address)).to.equal(tnd(1000));
    });

    it("refuse 1 000 TND + 1 unité", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      const tooMuch = tnd(1000) + 1n;
      await expect(token.connect(alice).faucet(tooMuch))
        .to.be.revertedWithCustomError(token, "FaucetAmountTooHigh")
        .withArgs(tooMuch, tnd(1000));
    });

    it("refuse un montant nul", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await expect(token.connect(alice).faucet(0)).to.be.revertedWithCustomError(token, "FaucetZeroAmount");
    });

    it("limite par appel : plusieurs appels successifs sont permis", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.connect(alice).faucet(tnd(1000));
      await token.connect(alice).faucet(tnd(1000));
      expect(await token.balanceOf(alice.address)).to.equal(tnd(2000));
    });
  });

  describe("Transferts", function () {
    it("transfère entre deux comptes", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await token.connect(alice).faucet(tnd(50));
      await expect(token.connect(alice).transfer(bob.address, tnd(30))).to.changeTokenBalances(
        token,
        [alice, bob],
        [-tnd(30), tnd(30)],
      );
    });

    it("refuse un transfert supérieur au solde (erreur OpenZeppelin)", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await token.connect(alice).faucet(tnd(10));
      await expect(token.connect(alice).transfer(bob.address, tnd(11)))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(alice.address, tnd(10), tnd(11));
    });

    it("refuse un transfert vers l'adresse nulle", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.connect(alice).faucet(tnd(10));
      await expect(token.connect(alice).transfer(ethers.ZeroAddress, 1n))
        .to.be.revertedWithCustomError(token, "ERC20InvalidReceiver")
        .withArgs(ethers.ZeroAddress);
    });
  });

  describe("approve et transferFrom", function () {
    it("approve fixe l'allocation et émet Approval", async function () {
      const { token, alice, spender } = await loadFixture(deployFixture);
      await expect(token.connect(alice).approve(spender.address, tnd(30)))
        .to.emit(token, "Approval")
        .withArgs(alice.address, spender.address, tnd(30));
      expect(await token.allowance(alice.address, spender.address)).to.equal(tnd(30));
    });

    it("transferFrom déplace les jetons et consomme l'allocation", async function () {
      const { token, alice, bob, spender } = await loadFixture(deployFixture);
      await token.connect(alice).faucet(tnd(100));
      await token.connect(alice).approve(spender.address, tnd(30));
      await expect(token.connect(spender).transferFrom(alice.address, bob.address, tnd(30))).to.changeTokenBalances(
        token,
        [alice, bob],
        [-tnd(30), tnd(30)],
      );
      expect(await token.allowance(alice.address, spender.address)).to.equal(0n);
    });

    it("refuse transferFrom au-delà de l'allocation", async function () {
      const { token, alice, bob, spender } = await loadFixture(deployFixture);
      await token.connect(alice).faucet(tnd(100));
      await token.connect(alice).approve(spender.address, tnd(29));
      await expect(token.connect(spender).transferFrom(alice.address, bob.address, tnd(30)))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance")
        .withArgs(spender.address, tnd(29), tnd(30));
    });

    it("refuse transferFrom si l'allocation suffit mais pas le solde", async function () {
      const { token, alice, bob, spender } = await loadFixture(deployFixture);
      await token.connect(alice).faucet(tnd(10));
      await token.connect(alice).approve(spender.address, tnd(30));
      await expect(token.connect(spender).transferFrom(alice.address, bob.address, tnd(30)))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(alice.address, tnd(10), tnd(30));
    });

    it("une allocation maximale (type(uint256).max) n'est pas décrémentée", async function () {
      const { token, alice, bob, spender } = await loadFixture(deployFixture);
      await token.connect(alice).faucet(tnd(100));
      await token.connect(alice).approve(spender.address, ethers.MaxUint256);
      await token.connect(spender).transferFrom(alice.address, bob.address, tnd(30));
      expect(await token.allowance(alice.address, spender.address)).to.equal(ethers.MaxUint256);
    });
  });

  describe("Compatibilité SafeERC20 (comme DepositVault)", function () {
    async function probeFixture() {
      const base = await deployFixture();
      const probe = await ethers.deployContract("SafeERC20Probe", [await base.token.getAddress()]);
      return { ...base, probe };
    }

    it("safeTransferFrom après approve, puis safeTransfer", async function () {
      const { token, alice, bob, probe } = await loadFixture(probeFixture);
      await token.connect(alice).faucet(tnd(30));
      await token.connect(alice).approve(await probe.getAddress(), tnd(30));

      await expect(probe.pull(alice.address, tnd(30))).to.changeTokenBalances(token, [alice, probe], [-tnd(30), tnd(30)]);
      await expect(probe.push(bob.address, tnd(30))).to.changeTokenBalances(token, [probe, bob], [-tnd(30), tnd(30)]);
    });

    it("safeTransferFrom sans approve échoue et ne déplace rien", async function () {
      const { token, alice, probe } = await loadFixture(probeFixture);
      await token.connect(alice).faucet(tnd(30));
      await expect(probe.pull(alice.address, tnd(30))).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
      expect(await token.balanceOf(alice.address)).to.equal(tnd(30));
    });
  });
});

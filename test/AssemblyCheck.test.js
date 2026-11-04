// Vérifie que DepositVault s'assemble avec la FORME prévue de SlotBooking (cahier §6) :
// BookingEscrow is SlotBooking, DepositVault. Ce n'est pas le SlotBooking du Membre 1 (contracts/test/AssemblyCheck.sol).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const tnd = (amount) => ethers.parseUnits(String(amount), 6);

describe("Assemblage BookingEscrow (forme)", function () {
  it("les crochets fonctionnent à travers l'héritage multiple, onlyCenterStaff compris", async function () {
    const [admin, treasury, staff, alice, stranger] = await ethers.getSigners();
    const token = await ethers.deployContract("MockTND");
    const escrow = await ethers.deployContract("BookingEscrowShape", [admin.address, await token.getAddress()]);
    await escrow.setDeposit(1, tnd(30));
    await escrow.setTreasury(1, treasury.address);
    await escrow.setStaff(1, staff.address, true);
    await token.connect(alice).faucet(tnd(100));
    await token.connect(alice).approve(await escrow.getAddress(), tnd(60));

    await escrow.connect(alice).create(1, 1);
    await escrow.connect(alice).create(2, 1);
    await escrow.cancel(1, BigInt(await time.latest()) + 48n * 3600n);
    await expect(escrow.connect(stranger).complete(2, 1)).to.be.revertedWithCustomError(escrow, "NotCenterStaff");
    await escrow.connect(staff).complete(2, 1);

    expect(await escrow.balanceOf(alice.address)).to.equal(tnd(30));
    expect(await escrow.balanceOf(treasury.address)).to.equal(tnd(30));
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(tnd(60));
  });
});

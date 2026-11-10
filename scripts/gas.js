// Mesure du gaz consommé par les opérations d'une réservation (réseau Hardhat en mémoire).
// Lancer : npx hardhat run scripts/gas.js
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function main() {
  const [admin, manager, treasury, staff, alice] = await ethers.getSigners();
  const tnd = (n) => ethers.parseUnits(String(n), 6);
  const token = await ethers.deployContract("MockTND");
  const escrow = await ethers.deployContract("BookingEscrow", [admin.address, await token.getAddress()]);
  const gas = async (label, tx) => console.log(label.padEnd(38), String((await (await tx).wait()).gasUsed).padStart(8), "gaz");

  await gas("Déploiement MockTND", token.deploymentTransaction());
  await gas("Déploiement BookingEscrow", escrow.deploymentTransaction());
  await gas("setCenterManager (admin)", escrow.setCenterManager(1, manager.address));
  await gas("setDeposit (gérant)", escrow.connect(manager).setDeposit(1, tnd(30)));
  await gas("setTreasury (gérant)", escrow.connect(manager).setTreasury(1, treasury.address));
  await gas("setStaff (gérant)", escrow.connect(manager).setStaff(1, staff.address, true));
  await gas("faucet 100 MockTND (client)", token.connect(alice).faucet(tnd(100)));
  await gas("approve (client)", token.connect(alice).approve(await escrow.getAddress(), tnd(30)));
  const start = Math.ceil(((await time.latest()) + 48 * 3600) / 1800) * 1800;
  await gas("createBooking (client)", escrow.connect(alice).createBooking(1, 7, start));
  await token.connect(alice).approve(await escrow.getAddress(), tnd(30));
  await escrow.connect(alice).createBooking(1, 8, start);
  await gas("cancelBooking ≥ 24 h (client)", escrow.connect(alice).cancelBooking(1));
  await gas("withdraw (client remboursé)", escrow.connect(alice).withdraw());
  await time.increaseTo(start);
  await gas("markCompleted (staff)", escrow.connect(staff).markCompleted(2));
  await gas("withdraw (trésorerie)", escrow.connect(treasury).withdraw());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

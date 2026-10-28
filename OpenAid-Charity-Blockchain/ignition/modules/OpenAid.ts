import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("OpenAidModule", (m) => {
  const registry = m.contract("CharityRegistry");
  const factory = m.contract("CharityFactory", [registry]);

  return { registry, factory };
});

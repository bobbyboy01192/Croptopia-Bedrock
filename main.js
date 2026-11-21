import { world, system, ItemStack, BlockPermutation } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { GUIDE_CATEGORIES, FARMLAND_CROPS, TREE_CROPS, SAPLINGS, ALL_SEEDS } from "./guide_data.js";

const CONFIG_PROP_KEY = "croptopia:config";
const DEFAULT_CONFIG = {
  treeSpawnRate: 50,
  plantSpawnRate: 50,
  cropGrowthSpeed: 35,
  fruitGrowthSpeed: 25,
  grassSeedDropChance: 12,
  fruitLeafRatio: 18,
  rightClickHarvest: true,
  blockCoverOnCrops: true,
  allowBoneMeal: true
};

let cachedConfig = null;

function getConfig() {
  if (cachedConfig) return cachedConfig;
  let loaded = {};
  try {
    const raw = world.getDynamicProperty(CONFIG_PROP_KEY);
    if (typeof raw === "string" && raw.length > 0) {
      loaded = JSON.parse(raw);
    }
  } catch {}
  cachedConfig = { ...DEFAULT_CONFIG, ...loaded };
  return cachedConfig;
}

function saveConfig(nextCfg) {
  cachedConfig = { ...DEFAULT_CONFIG, ...nextCfg };
  try {
    world.setDynamicProperty(CONFIG_PROP_KEY, JSON.stringify(cachedConfig));
  } catch {}
}

function isOperator(player) {
  if (!player) return false;
  try {
    if (typeof player.playerPermissionLevel === "number" && player.playerPermissionLevel >= 2) return true;
    if (typeof player.commandPermissionLevel === "number" && player.commandPermissionLevel >= 1) return true;
    if (typeof player.isOp === "function" && player.isOp()) return true;
  } catch {}
  return false;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function consumeMainhandItem(player) {
  try {
    if (String(player.getGameMode()).toLowerCase() === "creative") return;
  } catch {}
  const equip = player.getComponent("minecraft:equippable") || player.getComponent("equippable");
  if (!equip) return;
  const held = equip.getEquipment("Mainhand");
  if (!held) return;
  if (held.amount > 1) {
    held.amount -= 1;
    equip.setEquipment("Mainhand", held);
  } else {
    equip.setEquipment("Mainhand", undefined);
  }
}

function getMainhandItem(player) {
  const equip = player.getComponent("minecraft:equippable") || player.getComponent("equippable");
  if (!equip) return undefined;
  return equip.getEquipment("Mainhand");
}

const DISALLOWED_CROP_COVER_EXACT = new Set([
  "minecraft:leaf_litter",
  "minecraft:pink_petals",
  "minecraft:wildflowers",
  "minecraft:moss_carpet",
  "minecraft:pale_moss_carpet",
  "minecraft:flower_pot",
  "minecraft:scaffolding",
  "minecraft:redstone",
  "minecraft:repeater",
  "minecraft:comparator",
  "minecraft:lever",
  "minecraft:deadbush",
  "minecraft:short_grass",
  "minecraft:tall_grass",
  "minecraft:tallgrass",
  "minecraft:fern",
  "minecraft:large_fern",
  "minecraft:bush",
  "minecraft:firefly_bush",
  "minecraft:cactus_flower",
  "minecraft:short_dry_grass",
  "minecraft:tall_dry_grass",
  "minecraft:glow_lichen",
  "minecraft:vine",
  "minecraft:sculk_vein",
  "minecraft:resin_clump",
  "minecraft:torch",
  "minecraft:soul_torch",
  "minecraft:redstone_torch",
  "minecraft:rail",
  "minecraft:golden_rail",
  "minecraft:detector_rail",
  "minecraft:activator_rail"
]);

function isDisallowedCropCover(typeId) {
  if (!typeId) return false;
  if (DISALLOWED_CROP_COVER_EXACT.has(typeId)) return true;
  if (
    typeId.endsWith("_carpet") ||
    typeId.endsWith("_pressure_plate") ||
    typeId.endsWith("_button") ||
    typeId.endsWith("_torch") ||
    typeId.endsWith("_rail") ||
    typeId.endsWith("_sign") ||
    typeId.endsWith("_banner") ||
    typeId.endsWith("_candle") ||
    typeId.endsWith("_coral") ||
    typeId.endsWith("_coral_fan")
  ) {
    return true;
  }
  return false;
}

const FLOATING_COVER_ABOVE = new Set([
  "minecraft:leaf_litter",
  "minecraft:pink_petals",
  "minecraft:wildflowers",
  "minecraft:snow_layer"
]);

function clearFloatingCoverAbove(block) {
  if (!getConfig().blockCoverOnCrops) return;
  try {
    const above = block.above(1);
    if (above && FLOATING_COVER_ABOVE.has(above.typeId)) {
      above.setPermutation(BlockPermutation.resolve("minecraft:air"));
    }
  } catch {}
}

function isTreeReplaceable(b) {
  if (!b) return false;
  if (b.isAir) return true;
  const id = b.typeId;
  return (
    id.includes("leaves") ||
    id.includes("_crop") ||
    id === "minecraft:snow_layer" ||
    id === "minecraft:leaf_litter" ||
    id === "minecraft:pink_petals" ||
    id === "minecraft:wildflowers" ||
    id === "minecraft:short_grass" ||
    id === "minecraft:tallgrass"
  );
}

function growTreeAt(dimension, loc, saplingInfo, isWild = false) {
  const { x, y, z } = loc;
  const baseH = saplingInfo.baseHeight ?? 4;
  const randH = saplingInfo.heightRand ?? 3;
  const trunkHeight = baseH + randomInt(0, randH);

  // Verify the entire 5x5 canopy bounding box and base are inside loaded chunks
  // so trees NEVER get sliced off at unloaded chunk borders!
  try {
    const checkYs = [y - 1, y, y + trunkHeight - 2, y + trunkHeight + 1];
    for (const cy of checkYs) {
      for (const dx of [-2, 0, 2]) {
        for (const dz of [-2, 0, 2]) {
          const cb = dimension.getBlock({ x: x + dx, y: cy, z: z + dz });
          if (!cb) return "unloaded";
        }
      }
    }
  } catch {
    return "unloaded";
  }

  // Check vertical clearance (must have clear air/leaves above sapling)
  for (let dy = 1; dy <= trunkHeight + 1; dy++) {
    let b;
    try {
      b = dimension.getBlock({ x, y: y + dy, z });
    } catch {
      return "unloaded";
    }
    if (!b) return "unloaded";
    if (!isTreeReplaceable(b)) {
      return "blocked";
    }
  }

  // Convert block underneath trunk to dirt (matching Java below_trunk_provider)
  try {
    const below = dimension.getBlock({ x, y: y - 1, z });
    if (below && (below.typeId === "minecraft:grass_block" || below.typeId === "minecraft:grass" || below.typeId === "minecraft:podzol")) {
      below.setPermutation(BlockPermutation.resolve("minecraft:dirt"));
    }
  } catch {}

  // Java BlobFoliagePlacer (radius 2 on lower 2 layers, radius 1 on top 2 layers, randomized corners)
  // Exact Java Croptopia weighted foliage ratio: 90 vanilla leaves : 20 fruit crop leaves (20/110 ~= 18.2%)
  for (let offset = -2; offset <= 1; offset++) {
    const ly = y + trunkHeight + offset;
    const radius = offset <= -1 ? 2 : 1;
    for (let lx = x - radius; lx <= x + radius; lx++) {
      for (let lz = z - radius; lz <= z + radius; lz++) {
        const isCorner = Math.abs(lx - x) === radius && Math.abs(lz - z) === radius;
        if (isCorner) {
          if (offset === 1) continue; // Top layer is always + shape
          if (Math.random() < 0.5) continue; // Randomized corners so every tree looks different
        }
        try {
          const target = dimension.getBlock({ x: lx, y: ly, z: lz });
          if (target && isTreeReplaceable(target)) {
            const fruitChance = Math.max(0, Math.min(100, getConfig().fruitLeafRatio)) / 100;
            if (saplingInfo.cropLeaf && Math.random() < fruitChance) {
              const initAge = isWild ? 3 : randomInt(0, 2);
              target.setPermutation(BlockPermutation.resolve(saplingInfo.cropLeaf, { "croptopia:age": initAge }));
            } else {
              target.setPermutation(BlockPermutation.resolve(saplingInfo.leaf));
            }
          }
        } catch {}
      }
    }
  }

  // Place trunk
  for (let dy = 0; dy < trunkHeight; dy++) {
    try {
      const tb = dimension.getBlock({ x, y: y + dy, z });
      if (tb) {
        tb.setPermutation(BlockPermutation.resolve(saplingInfo.log));
      }
    } catch {}
  }
  return "grown";
}

const recentBlockInteractions = new Set();
function markInteraction(block) {
  const key = `${block.dimension.id}:${block.location.x},${block.location.y},${block.location.z}:${system.currentTick}`;
  if (recentBlockInteractions.has(key)) return false;
  recentBlockInteractions.add(key);
  system.runTimeout(() => recentBlockInteractions.delete(key), 2);
  return true;
}

function handleFarmlandCropInteract(block, player, itemStack) {
  if (!block || player?.isSneaking) return;
  const info = FARMLAND_CROPS[block.typeId];
  if (!info) return;

  const cfg = getConfig();
  const age = block.permutation.getState("croptopia:age") ?? 0;
  const held = itemStack ?? (player ? getMainhandItem(player) : undefined);

  if (cfg.allowBoneMeal && held && held.typeId === "minecraft:bone_meal" && age < 7) {
    if (!markInteraction(block)) return;
    const nextAge = Math.min(7, age + randomInt(2, 5));
    block.setPermutation(BlockPermutation.resolve(block.typeId, { "croptopia:age": nextAge, "croptopia:wild": false }));
    const center = { x: block.location.x + 0.5, y: block.location.y + 0.5, z: block.location.z + 0.5 };
    try {
      block.dimension.spawnParticle("minecraft:crop_growth_emitter", center);
      block.dimension.playSound("item.bone_meal.use", center);
    } catch {}
    if (player) consumeMainhandItem(player);
    return;
  }

  if (cfg.rightClickHarvest && age >= 7) {
    if (!markInteraction(block)) return;
    block.setPermutation(BlockPermutation.resolve(block.typeId, { "croptopia:age": 0, "croptopia:wild": false }));
    const center = { x: block.location.x + 0.5, y: block.location.y + 0.35, z: block.location.z + 0.5 };
    const dropCount = randomInt(1, 3);
    block.dimension.spawnItem(new ItemStack(info.drop, dropCount), center);
    try {
      block.dimension.playSound("block.sweet_berry_bush.pick_berries", center);
    } catch {}
  }
}

function handleLeafCropInteract(block, player, itemStack) {
  if (!block || player?.isSneaking) return;
  const info = TREE_CROPS[block.typeId];
  if (!info) return;

  const cfg = getConfig();
  const age = block.permutation.getState("croptopia:age") ?? 0;
  const held = itemStack ?? (player ? getMainhandItem(player) : undefined);

  if (cfg.allowBoneMeal && held && held.typeId === "minecraft:bone_meal" && age < 3) {
    if (!markInteraction(block)) return;
    const nextAge = Math.min(3, age + randomInt(1, 2));
    block.setPermutation(BlockPermutation.resolve(block.typeId, { "croptopia:age": nextAge }));
    const center = { x: block.location.x + 0.5, y: block.location.y + 0.5, z: block.location.z + 0.5 };
    try {
      block.dimension.spawnParticle("minecraft:crop_growth_emitter", center);
      block.dimension.playSound("item.bone_meal.use", center);
    } catch {}
    if (player) consumeMainhandItem(player);
    return;
  }

  if (cfg.rightClickHarvest && age >= 3) {
    if (!markInteraction(block)) return;
    block.setPermutation(BlockPermutation.resolve(block.typeId, { "croptopia:age": 0 }));
    const center = { x: block.location.x + 0.5, y: block.location.y + 0.2, z: block.location.z + 0.5 };
    block.dimension.spawnItem(new ItemStack(info.drop, 1), center);
    try {
      block.dimension.playSound("block.sweet_berry_bush.pick_berries", center);
    } catch {}
  }
}

function handleSaplingInteract(block, player, itemStack) {
  if (!block || player?.isSneaking) return;
  const info = SAPLINGS[block.typeId];
  if (!info) return;
  if (!getConfig().allowBoneMeal) return;
  const held = itemStack ?? (player ? getMainhandItem(player) : undefined);
  if (!held || held.typeId !== "minecraft:bone_meal") return;
  if (!markInteraction(block)) return;

  const center = { x: block.location.x + 0.5, y: block.location.y + 0.5, z: block.location.z + 0.5 };
  try {
    block.dimension.spawnParticle("minecraft:crop_growth_emitter", center);
    block.dimension.playSound("item.bone_meal.use", center);
  } catch {}
  if (player) consumeMainhandItem(player);

  if (Math.random() < 0.45) {
    growTreeAt(block.dimension, block.location, info);
  } else {
    const stage = block.permutation.getState("croptopia:stage") ?? 0;
    if (stage === 0) {
      block.setPermutation(block.permutation.withState("croptopia:stage", 1));
    } else {
      growTreeAt(block.dimension, block.location, info);
    }
  }
}

function handleCinnamonLogInteract(block, player, itemStack) {
  if (!block || !player || player.isSneaking) return;
  const held = itemStack ?? getMainhandItem(player);
  if (!held) return;
  const isAxe = held.typeId.endsWith("_axe") || (typeof held.hasTag === "function" && held.hasTag("minecraft:is_axe"));
  if (!isAxe) return;
  if (!markInteraction(block)) return;

  const strippedId = block.typeId === "croptopia:cinnamon_log"
    ? "croptopia:stripped_cinnamon_log"
    : "croptopia:stripped_cinnamon_wood";

  const face = block.permutation.getState("minecraft:block_face");
  const newPerm = face
    ? BlockPermutation.resolve(strippedId, { "minecraft:block_face": face })
    : BlockPermutation.resolve(strippedId);

  block.setPermutation(newPerm);
  const center = { x: block.location.x + 0.5, y: block.location.y + 0.5, z: block.location.z + 0.5 };
  block.dimension.spawnItem(new ItemStack("croptopia:cinnamon", 1), center);
  try {
    block.dimension.playSound("use.wood", center);
  } catch {}
}

// High-contrast Interactive Croptopia Guide Book UI (debounced so it never opens twice!)
const guideOpenPlayers = new Set();
const guideLastOpenTick = new Map();

function triggerGuideBook(player) {
  if (!player) return;
  const now = system.currentTick;
  const last = guideLastOpenTick.get(player.id) ?? -100;
  if (now - last < 10 || guideOpenPlayers.has(player.id)) return;
  guideLastOpenTick.set(player.id, now);
  guideOpenPlayers.add(player.id);
  system.run(() => openGuideBook(player));
}

function openGuideBook(player) {
  const op = isOperator(player);
  const form = new ActionFormData()
    .title("Croptopia Guide Book")
    .body("Welcome to Croptopia! Select a category below to browse crops, fruit trees, utensils, and recipes:");

  if (op) {
    form.button("§6[OP] Croptopia Config", "textures/items/guide");
  }
  for (const cat of GUIDE_CATEGORIES) {
    form.button(`${cat.name} (${cat.entries.length})`, cat.icon);
  }

  form.show(player).then((res) => {
    if (res.canceled || res.selection === undefined) {
      guideOpenPlayers.delete(player.id);
      return;
    }
    if (op) {
      if (res.selection === 0) {
        openConfigMenu(player);
        return;
      }
      const cat = GUIDE_CATEGORIES[res.selection - 1];
      if (cat) openGuideCategory(player, cat);
      else guideOpenPlayers.delete(player.id);
    } else {
      const cat = GUIDE_CATEGORIES[res.selection];
      if (cat) openGuideCategory(player, cat);
      else guideOpenPlayers.delete(player.id);
    }
  }).catch(() => {
    guideOpenPlayers.delete(player.id);
  });
}

function openConfigMenu(player) {
  if (!isOperator(player)) {
    guideOpenPlayers.delete(player.id);
    return;
  }
  const cfg = getConfig();
  const form = new ModalFormData()
    .title("Croptopia Config (OP)")
    .slider("Tree Spawn Rate (% | 50 = Default, 100 = 2x)", 0, 100, { valueStep: 5, defaultValue: cfg.treeSpawnRate })
    .slider("Wild Plant Spawn Rate (% | 50 = Default, 100 = 2x)", 0, 100, { valueStep: 5, defaultValue: cfg.plantSpawnRate })
    .slider("Crop Growth Speed (% per tick | Default 35)", 0, 100, { valueStep: 5, defaultValue: cfg.cropGrowthSpeed })
    .slider("Fruit Tree Growth Speed (% per tick | Default 25)", 0, 100, { valueStep: 5, defaultValue: cfg.fruitGrowthSpeed })
    .slider("Tall Grass Seed Drop Chance (% | Default 12)", 0, 100, { valueStep: 2, defaultValue: cfg.grassSeedDropChance })
    .slider("Fruit Leaf Ratio on Trees (% | Default 18)", 0, 100, { valueStep: 5, defaultValue: cfg.fruitLeafRatio })
    .toggle("Right-Click Harvest Crops & Fruit", { defaultValue: cfg.rightClickHarvest })
    .toggle("Block Leaf Litter / Cover on Crops", { defaultValue: cfg.blockCoverOnCrops })
    .toggle("Allow Bone Meal on Crops & Trees", { defaultValue: cfg.allowBoneMeal })
    .toggle("Reset All Settings to Defaults", { defaultValue: false })
    .submitButton("Save Settings");

  form.show(player).then((res) => {
    if (res.canceled || !res.formValues) {
      openGuideBook(player);
      return;
    }
    const [
      treeSpawnRate,
      plantSpawnRate,
      cropGrowthSpeed,
      fruitGrowthSpeed,
      grassSeedDropChance,
      fruitLeafRatio,
      rightClickHarvest,
      blockCoverOnCrops,
      allowBoneMeal,
      resetDefaults
    ] = res.formValues;

    if (resetDefaults) {
      saveConfig({ ...DEFAULT_CONFIG });
      try {
        player.onScreenDisplay?.setActionBar("§aCroptopia Config reset to defaults!");
      } catch {}
    } else {
      saveConfig({
        treeSpawnRate: Number(treeSpawnRate),
        plantSpawnRate: Number(plantSpawnRate),
        cropGrowthSpeed: Number(cropGrowthSpeed),
        fruitGrowthSpeed: Number(fruitGrowthSpeed),
        grassSeedDropChance: Number(grassSeedDropChance),
        fruitLeafRatio: Number(fruitLeafRatio),
        rightClickHarvest: Boolean(rightClickHarvest),
        blockCoverOnCrops: Boolean(blockCoverOnCrops),
        allowBoneMeal: Boolean(allowBoneMeal)
      });
      try {
        player.onScreenDisplay?.setActionBar("§aCroptopia Config saved!");
      } catch {}
    }
    openGuideBook(player);
  }).catch(() => {
    guideOpenPlayers.delete(player.id);
  });
}

function openGuideCategory(player, cat) {
  const form = new ActionFormData()
    .title(cat.name)
    .body(cat.description || "Select an entry:");

  form.button("< Back to Categories");
  for (const entry of cat.entries) {
    form.button(entry.name, entry.icon);
  }

  form.show(player).then((res) => {
    if (res.canceled || res.selection === undefined) {
      guideOpenPlayers.delete(player.id);
      return;
    }
    if (res.selection === 0) {
      openGuideBook(player);
      return;
    }
    const entry = cat.entries[res.selection - 1];
    if (entry) openGuideEntry(player, cat, entry);
    else guideOpenPlayers.delete(player.id);
  }).catch(() => {
    guideOpenPlayers.delete(player.id);
  });
}

function openGuideEntry(player, cat, entry) {
  const form = new ActionFormData()
    .title(entry.name)
    .body(entry.body)
    .button("< Back to " + cat.name);

  form.show(player).then((res) => {
    if (!res.canceled) openGuideCategory(player, cat);
    else guideOpenPlayers.delete(player.id);
  }).catch(() => {
    guideOpenPlayers.delete(player.id);
  });
}

const recentFoodEffects = new Map();

function applySpecialFoodEffects(player, itemId) {
  if (!player || !itemId) return;
  const now = system.currentTick;
  const key = `${player.id}:${itemId}`;
  const last = recentFoodEffects.get(key) ?? -100;
  if (now - last < 3) return;
  recentFoodEffects.set(key, now);

  try {
    if (itemId === "croptopia:glowing_calamari") {
      player.addEffect("night_vision", 1200, { amplifier: 0, showParticles: true });
    } else if (itemId === "croptopia:dragon_egg_omelette") {
      player.addEffect("strength", 3000, { amplifier: 1, showParticles: true });
      player.addEffect("regeneration", 400, { amplifier: 1, showParticles: true });
    } else if (itemId === "croptopia:nether_star_cake") {
      player.addEffect("resistance", 3000, { amplifier: 1, showParticles: true });
      player.addEffect("absorption", 1200, { amplifier: 1, showParticles: true });
    } else if (itemId === "croptopia:raw_ravager_meat") {
      if (Math.random() < 0.25) player.addEffect("poison", 200, { amplifier: 0, showParticles: true });
      if (Math.random() < 0.15) player.addEffect("hunger", 600, { amplifier: 0, showParticles: true });
    } else if (itemId === "croptopia:transcendental_breakfast") {
      player.addEffect("nausea", 160, { amplifier: 0, showParticles: true });
      player.addEffect("regeneration", 1200, { amplifier: 2, showParticles: true });
      player.addEffect("resistance", 1200, { amplifier: 1, showParticles: true });
    } else if (itemId === "croptopia:enchanted_rootbeer_float") {
      const goodEffects = [
        { id: "regeneration", ticks: 600, amp: 1 },
        { id: "absorption", ticks: 2400, amp: 2 },
        { id: "resistance", ticks: 2400, amp: 0 },
        { id: "speed", ticks: 2400, amp: 1 },
        { id: "strength", ticks: 2400, amp: 1 },
        { id: "fire_resistance", ticks: 2400, amp: 0 },
        { id: "haste", ticks: 2400, amp: 1 },
        { id: "jump_boost", ticks: 2400, amp: 1 },
        { id: "night_vision", ticks: 2400, amp: 0 },
        { id: "water_breathing", ticks: 2400, amp: 0 },
        { id: "health_boost", ticks: 2400, amp: 1 },
        { id: "saturation", ticks: 200, amp: 0 }
      ];
      const pick = goodEffects[Math.floor(Math.random() * goodEffects.length)];
      player.addEffect(pick.id, pick.ticks, { amplifier: pick.amp, showParticles: true });
    }
  } catch {}
}

function registerCroptopiaComponents(event) {
  const blockReg = event.blockComponentRegistry;
  const itemReg = event.itemComponentRegistry;

  if (blockReg) {
    blockReg.registerCustomComponent("croptopia:crop", {
      onTick(e) {
        const cfg = getConfig();
        const isWild = e.block.permutation.getState("croptopia:wild") === true;
        if (isWild) {
          if (Math.random() * 100 >= cfg.plantSpawnRate) {
            try {
              e.block.setPermutation(BlockPermutation.resolve("minecraft:air"));
            } catch {}
            return;
          }
          try {
            e.block.setPermutation(e.block.permutation.withState("croptopia:wild", false));
          } catch {}
          clearFloatingCoverAbove(e.block);
          return;
        }
        clearFloatingCoverAbove(e.block);
        const age = e.block.permutation.getState("croptopia:age") ?? 0;
        if (age < 7 && Math.random() * 100 < cfg.cropGrowthSpeed) {
          e.block.setPermutation(e.block.permutation.withState("croptopia:age", age + 1));
        }
      }
    });

    blockReg.registerCustomComponent("croptopia:leaf_crop", {
      beforeOnPlayerPlace(e) {
        try {
          if (e.permutationToPlace) {
            e.permutationToPlace = e.permutationToPlace.withState("croptopia:age", 0);
          }
        } catch {}
      },
      onTick(e) {
        const cfg = getConfig();
        const age = e.block.permutation.getState("croptopia:age") ?? 0;
        if (age < 3 && Math.random() * 100 < cfg.fruitGrowthSpeed) {
          e.block.setPermutation(e.block.permutation.withState("croptopia:age", age + 1));
        }
      }
    });

    blockReg.registerCustomComponent("croptopia:sapling", {
      onTick(e) {
        const info = SAPLINGS[e.block.typeId];
        if (!info) return;
        const cfg = getConfig();
        const isWild = e.block.permutation.getState("croptopia:wild") === true;
        if (isWild) {
          if (Math.random() * 100 >= cfg.treeSpawnRate) {
            try {
              e.block.setPermutation(BlockPermutation.resolve("minecraft:air"));
            } catch {}
            return;
          }
          const res = growTreeAt(e.block.dimension, e.block.location, info, true);
          if (res === "blocked") {
            try {
              e.block.setPermutation(BlockPermutation.resolve("minecraft:air"));
            } catch {}
          }
          // If res === "unloaded", wait for the next tick once neighboring chunks finish loading!
          return;
        }
        clearFloatingCoverAbove(e.block);
        if (Math.random() * 100 >= cfg.fruitGrowthSpeed) return;
        const stage = e.block.permutation.getState("croptopia:stage") ?? 0;
        if (stage === 0) {
          e.block.setPermutation(e.block.permutation.withState("croptopia:stage", 1));
        } else {
          growTreeAt(e.block.dimension, e.block.location, info, false);
        }
      }
    });

    blockReg.registerCustomComponent("croptopia:cinnamon_log", {});
  }

  if (itemReg) {
    itemReg.registerCustomComponent("croptopia:guide", {
      onUse(e) {
        if (e.source) triggerGuideBook(e.source);
      }
    });

    itemReg.registerCustomComponent("croptopia:effect_food", {
      onConsume(e) {
        if (e.source && e.itemStack) {
          applySpecialFoodEffects(e.source, e.itemStack.typeId);
        }
      }
    });

    itemReg.registerCustomComponent("croptopia:sapling_item", {});
  }
}

if (system.beforeEvents?.startup) {
  system.beforeEvents.startup.subscribe(registerCroptopiaComponents);
} else if (world.beforeEvents?.worldInitialize) {
  world.beforeEvents.worldInitialize.subscribe(registerCroptopiaComponents);
}

// Ensure player-placed fruit crop leaves always start at stage 0 (bud) so they can be grown/bonemealed
// while their inventory icon shows the ripe fruit state!
world.afterEvents.playerPlaceBlock.subscribe((e) => {
  const { block } = e;
  if (!block || !TREE_CROPS[block.typeId]) return;
  try {
    const age = block.permutation.getState("croptopia:age") ?? 0;
    if (age !== 0) {
      block.setPermutation(BlockPermutation.resolve(block.typeId, { "croptopia:age": 0 }));
    }
  } catch {}
});

// Unified block interaction handler:
// - Shift-clicking (sneaking) ALWAYS allows placing blocks cleanly without harvesting, resetting, or breaking crops/leaves
// - Prevents leaf litter, petals, carpets, torches, rails, etc. from being placed on crops/saplings (snow_layer allowed for snowlogging)
// - Bone meal & right-click harvest work consistently on both placed crop leaves and tree crop leaves!
world.beforeEvents.playerInteractWithBlock.subscribe((e) => {
  const { block, player, itemStack } = e;
  if (!block) return;

  const cfg = getConfig();
  const heldId = itemStack?.typeId;

  if (cfg.blockCoverOnCrops && heldId && (FARMLAND_CROPS[block.typeId] || SAPLINGS[block.typeId])) {
    if (isDisallowedCropCover(heldId)) {
      e.cancel = true;
      return;
    }
  }

  // When sneaking (Shift + right-click), let the player place blocks normally without triggering crop/leaf interactions!
  if (player?.isSneaking) return;

  if (heldId && SAPLINGS[heldId]?.cropLeaf && block.typeId === SAPLINGS[heldId].leaf) {
    const sInfo = SAPLINGS[heldId];
    e.cancel = true;
    system.run(() => {
      try {
        if (!markInteraction(block)) return;
        block.setPermutation(BlockPermutation.resolve(sInfo.cropLeaf, { "croptopia:age": 0 }));
        if (player) consumeMainhandItem(player);
      } catch {}
    });
    return;
  }

  if (FARMLAND_CROPS[block.typeId]) {
    const age = block.permutation.getState("croptopia:age") ?? 0;
    if ((cfg.allowBoneMeal && heldId === "minecraft:bone_meal" && age < 7) || (cfg.rightClickHarvest && age >= 7)) {
      e.cancel = true;
      system.run(() => handleFarmlandCropInteract(block, player, itemStack));
    }
    return;
  }

  if (TREE_CROPS[block.typeId]) {
    const age = block.permutation.getState("croptopia:age") ?? 0;
    if ((cfg.allowBoneMeal && heldId === "minecraft:bone_meal" && age < 3) || (cfg.rightClickHarvest && age >= 3)) {
      e.cancel = true;
      system.run(() => handleLeafCropInteract(block, player, itemStack));
    }
    return;
  }

  if (SAPLINGS[block.typeId]) {
    if (cfg.allowBoneMeal && heldId === "minecraft:bone_meal") {
      e.cancel = true;
      system.run(() => handleSaplingInteract(block, player, itemStack));
    }
    return;
  }

  if (block.typeId === "croptopia:cinnamon_log" || block.typeId === "croptopia:cinnamon_wood") {
    const isAxe = heldId && (heldId.endsWith("_axe") || (typeof itemStack.hasTag === "function" && itemStack.hasTag("minecraft:is_axe")));
    if (isAxe) {
      e.cancel = true;
      system.run(() => handleCinnamonLogInteract(block, player, itemStack));
    }
  }
});

world.afterEvents.itemUse.subscribe((e) => {
  if (e.itemStack?.typeId === "croptopia:guide" && e.source) {
    triggerGuideBook(e.source);
  }
});

world.afterEvents.itemCompleteUse.subscribe((e) => {
  if (e.itemStack && e.source) {
    applySpecialFoodEffects(e.source, e.itemStack.typeId);
  }
});

// Entity loot modifiers
world.afterEvents.entityDie.subscribe((e) => {
  const entity = e.deadEntity;
  if (!entity || !entity.dimension) return;
  const id = entity.typeId;
  const loc = entity.location;

  try {
    if (id === "minecraft:cod" || id === "minecraft:salmon" || id === "minecraft:tropical_fish") {
      entity.dimension.spawnItem(new ItemStack("croptopia:roe", randomInt(1, 2)), loc);
    } else if (id === "minecraft:squid") {
      entity.dimension.spawnItem(new ItemStack("croptopia:calamari", 1), loc);
    } else if (id === "minecraft:glow_squid") {
      entity.dimension.spawnItem(new ItemStack("croptopia:glowing_calamari", 1), loc);
    } else if (id === "minecraft:ravager") {
      entity.dimension.spawnItem(new ItemStack("croptopia:raw_ravager_meat", randomInt(1, 2)), loc);
    }
  } catch {}
});

// Handle breaking mature crops directly & tall grass seed drops
// Breaking the ground beneath a growing crop or breaking an immature crop (age < 7) drops NOTHING!
world.afterEvents.playerBreakBlock.subscribe((e) => {
  const perm = e.brokenBlockPermutation;
  const brokenId = perm?.type?.id;
  if (!brokenId) return;

  if (FARMLAND_CROPS[brokenId]) {
    const age = perm.getState("croptopia:age") ?? 0;
    if (age >= 7) {
      const info = FARMLAND_CROPS[brokenId];
      const center = { x: e.block.location.x + 0.5, y: e.block.location.y + 0.5, z: e.block.location.z + 0.5 };
      try {
        e.dimension.spawnItem(new ItemStack(info.drop, randomInt(1, 3)), center);
      } catch {}
    }
    return;
  }

  if (TREE_CROPS[brokenId]) {
    const held = e.player ? getMainhandItem(e.player) : undefined;
    const center = { x: e.block.location.x + 0.5, y: e.block.location.y + 0.5, z: e.block.location.z + 0.5 };
    if (held && held.typeId === "minecraft:shears") {
      try {
        e.dimension.spawnItem(new ItemStack(brokenId, 1), center);
      } catch {}
      return;
    }
    const age = perm.getState("croptopia:age") ?? 0;
    if (age >= 3) {
      const info = TREE_CROPS[brokenId];
      try {
        e.dimension.spawnItem(new ItemStack(info.drop, 1), center);
      } catch {}
    }
    return;
  }

  if (
    brokenId === "minecraft:short_grass" ||
    brokenId === "minecraft:tallgrass" ||
    brokenId === "minecraft:fern" ||
    brokenId === "minecraft:large_fern"
  ) {
    if (Math.random() * 100 < getConfig().grassSeedDropChance && ALL_SEEDS.length > 0) {
      const seedId = ALL_SEEDS[Math.floor(Math.random() * ALL_SEEDS.length)];
      const center = { x: e.block.location.x + 0.5, y: e.block.location.y + 0.5, z: e.block.location.z + 0.5 };
      try {
        e.dimension.spawnItem(new ItemStack(seedId, 1), center);
      } catch {}
    }
  }
});

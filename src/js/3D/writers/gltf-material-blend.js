/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>, Marlamin <marlamin@marlamin.com>
	License: MIT
 */

/** M2Material.blendingMode values. */
const M2_BLEND = {
	OPAQUE: 0,
	ALPHA_KEY: 1,
	ALPHA: 2,
	NO_ALPHA_ADD: 3,
	ADD: 4,
	MOD: 5,
	MOD2X: 6,
	BLEND_ADD: 7
};

/** M2Material.flags values. */
const M2_MATERIAL_FLAG = {
	UNLIT: 0x1,
	UNFOGGED: 0x2,
	TWO_SIDED: 0x4
};

/**
 * Decorate a glTF material with the blend behaviour of the M2 material it is drawn with.
 * Written as its own module so it can be tested without the application runtime.
 *
 * glTF only has OPAQUE, MASK and BLEND. Additive and modulate have no equivalent, so they go out
 * as BLEND plus an extras hint a renderer can act on; a renderer that ignores extras still gets
 * ordinary transparency rather than a solid black quad.
 *
 * @param {object} material glTF material, modified in place
 * @param {object} blend { blendingMode, flags } from M2Material
 * @returns {object} the same material
 */
function applyMaterialBlend(material, blend) {
	if (!blend)
		return material;

	const { blendingMode, flags } = blend;
	const additive = blendingMode === M2_BLEND.NO_ALPHA_ADD || blendingMode === M2_BLEND.ADD ||
		blendingMode === M2_BLEND.BLEND_ADD;
	const modulate = blendingMode === M2_BLEND.MOD || blendingMode === M2_BLEND.MOD2X;

	if (blendingMode === M2_BLEND.ALPHA_KEY) {
		material.alphaMode = 'MASK';
		material.alphaCutoff = 0.5;
	} else if (blendingMode !== M2_BLEND.OPAQUE) {
		material.alphaMode = 'BLEND';
	}

	if (flags & M2_MATERIAL_FLAG.TWO_SIDED)
		material.doubleSided = true;

	// Unlit keeps glows and flames at full brightness instead of being shaded by scene lights.
	if (flags & M2_MATERIAL_FLAG.UNLIT)
		material.extensions = Object.assign({}, material.extensions, { KHR_materials_unlit: {} });

	if (additive || modulate) {
		material.extras = Object.assign({}, material.extras, {
			blendMode: additive ? 'add' : (blendingMode === M2_BLEND.MOD2X ? 'mod2x' : 'mod'),
			m2BlendingMode: blendingMode,
			m2MaterialFlags: flags
		});
	}

	return material;
}

module.exports = { applyMaterialBlend, M2_BLEND, M2_MATERIAL_FLAG };

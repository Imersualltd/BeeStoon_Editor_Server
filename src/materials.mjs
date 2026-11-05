/*
 * Material edits of a model
 * --------------------------------------------------
 * The Inspector changes a model's materials (base color,
 * metallic, roughness) and texture maps. The model file
 * (GLB) is never changed: edits are a small record kept
 * with the object and saved with every version.
 *
 *   object.materials = {
 *     "<index>": {                index in the model's list of
 *       color: '#rrggbb',         unique materials (load order)
 *       metalness: 0..1,
 *       roughness: 0..1,
 *       maps: {                   texture per slot:
 *         base | normal | metallic | roughness:
 *           '<textureId>'         an image uploaded for this session
 *           null                  removed (the model's own map off)
 *       }                         slot left out = the model's own map
 *     }
 *   }
 *
 * A material left out of the record is the model's own,
 * unchanged material. Texture images are uploaded once
 * (POST /assets?kind=texture, assets.mjs) and referenced
 * by id; only ids uploaded in this session are accepted.
 */

export const MAX_MATERIALS = 64;

export const TEXTURE_SLOTS = ['base', 'normal', 'metallic', 'roughness'];

export const TEXTURE_ID_PATTERN = /^[0-9a-f]{64}$/;

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;


function unit(value) {

    const n = Number(value);

    return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 1000) / 1000 : undefined;
}


/*
 * One edit from a client -> a clean patch, or null when it is
 * not valid. `textures` = ids uploaded for this session (a Map
 * or Set); null skips that check (saved data, checked on load).
 */
export function cleanMaterialPatch(patch, textures) {

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return null;
    }

    const clean = {};

    if (patch.color !== undefined) {
        if (!COLOR_PATTERN.test(String(patch.color))) {
            return null;
        }
        clean.color = String(patch.color).toLowerCase();
    }

    for (const key of ['metalness', 'roughness']) {
        if (patch[key] !== undefined) {
            const value = unit(patch[key]);
            if (value === undefined) {
                return null;
            }
            clean[key] = value;
        }
    }

    if (patch.maps !== undefined) {

        if (!patch.maps || typeof patch.maps !== 'object' || Array.isArray(patch.maps)) {
            return null;
        }

        clean.maps = {};

        for (const [slot, value] of Object.entries(patch.maps)) {

            if (!TEXTURE_SLOTS.includes(slot)) {
                return null;
            }

            if (value === null) {
                clean.maps[slot] = null;
            } else if (TEXTURE_ID_PATTERN.test(String(value)) && (!textures || textures.has(value))) {
                clean.maps[slot] = value;
            } else {
                return null;
            }
        }
    }

    return clean;
}


/*
 * The record with one material changed (patch merged into it),
 * or without it (patch null = the model's own material again).
 * null when the index is not valid.
 */
export function mergeMaterial(materials, index, patch) {

    if (!Number.isInteger(index) || index < 0 || index >= MAX_MATERIALS) {
        return null;
    }

    const next = { ...materials };

    if (patch === null) {
        delete next[index];
        return next;
    }

    const old = next[index] || {};

    next[index] = {
        ...old,
        ...patch,
        ...(patch.maps || old.maps ? { maps: { ...(old.maps || {}), ...(patch.maps || {}) } } : {})
    };

    return next;
}


// A saved record -> a clean one (invalid parts dropped)
export function cleanMaterials(saved) {

    const clean = {};

    if (!saved || typeof saved !== 'object') {
        return clean;
    }

    for (const [key, value] of Object.entries(saved)) {

        const index = Number(key);
        const patch = cleanMaterialPatch(value, null);

        if (Number.isInteger(index) && index >= 0 && index < MAX_MATERIALS && patch) {
            clean[index] = patch;
        }
    }

    return clean;
}


// Texture ids a record uses
export function texturesOf(materials) {

    const ids = new Set();

    for (const material of Object.values(materials || {})) {
        for (const value of Object.values(material?.maps || {})) {
            if (value) {
                ids.add(value);
            }
        }
    }

    return ids;
}

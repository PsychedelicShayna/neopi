import { t } from "@oh-my-pi/pi-utils/i18n";
import { uiProvenanceSuffix } from "../theme/provenance";
import { type ComposerStyle, registerComposerStyle } from "../index";
import type { SubmenuOption } from "./settings-defs";

/** Composer shape id; extensions may register additional values at runtime. */
export type ComposerShape = string;

/** Built-in composer choices and their shared settings/setup copy. */
export const BUILTIN_COMPOSER_SHAPES = [
	{
		value: "band",
		get label() {
			return t("overlays.composer_shape_registry.band_label");
		},
		get description() {
			return t("overlays.composer_shape_registry.band_description");
		},
	},
	{
		value: "box",
		get label() {
			return t("overlays.composer_shape_registry.box_label");
		},
		get description() {
			return t("overlays.composer_shape_registry.box_description");
		},
	},
	{
		value: "claude",
		label: "Claude Code",
		get description() {
			return t("overlays.composer_shape_registry.claude_description");
		},
	},
	{
		value: "pi",
		label: "Pi",
		get description() {
			return t("overlays.composer_shape_registry.pi_description");
		},
	},
	{
		value: "borderless",
		get label() {
			return t("overlays.composer_shape_registry.borderless_label");
		},
		get description() {
			return t("overlays.composer_shape_registry.borderless_description");
		},
	},
	{
		value: "rule",
		get label() {
			return t("overlays.composer_shape_registry.rule_label");
		},
		get description() {
			return t("overlays.composer_shape_registry.rule_description");
		},
	},
	{
		value: "field",
		get label() {
			return t("overlays.composer_shape_registry.field_label");
		},
		get description() {
			return t("overlays.composer_shape_registry.field_description");
		},
	},
	{
		value: "rail",
		get label() {
			return t("overlays.composer_shape_registry.rail_label");
		},
		get description() {
			return t("overlays.composer_shape_registry.rail_description");
		},
	},
] as const;

/** Built-in composer ids used by tests and non-runtime consumers. */
export const COMPOSER_SHAPE_VALUES = BUILTIN_COMPOSER_SHAPES.map(shape => shape.value);

/** Visual composer style and selector copy registered by an extension. */
export interface ComposerShapeDefinition {
	label: string;
	description?: string;
	style: ComposerStyle;
}

const extensionComposerShapes = new Map<string, SubmenuOption>();

/** Install one extension composer shape into rendering and selector registries. */
export function installExtensionComposerShape(definition: ComposerShapeDefinition): () => void {
	const unregisterStyle = registerComposerStyle(definition.style);
	const id = definition.style.id;
	const option: SubmenuOption = {
		value: id,
		label: definition.label,
		description: definition.description,
	};
	extensionComposerShapes.set(id, option);
	return () => {
		if (extensionComposerShapes.get(id) === option) extensionComposerShapes.delete(id);
		unregisterStyle();
	};
}

/** Available built-in and extension composer choices in selector order. */
export function getComposerShapeOptions(): readonly SubmenuOption[] {
	return [
		...BUILTIN_COMPOSER_SHAPES.map(shape => ({
			...shape,
			label: shape.label + uiProvenanceSuffix("composerShapes", shape.value),
		})),
		...extensionComposerShapes.values(),
	];
}

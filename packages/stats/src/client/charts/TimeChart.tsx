import { formatBucket, formatTick } from "../data/range";
import { useLocale } from "../i18n";
import { Chart, type ChartProps } from "./Chart";

export interface TimeChartProps extends Omit<ChartProps, "slots" | "tickLabel" | "tooltipTitle" | "onSelect"> {
	/** Ascending bucket starts (see `bucketAxis`); series values align with them. */
	buckets: readonly number[];
	bucketMs: number;
	onSelectBucket?: (bucketStart: number) => void;
}

/** {@link Chart} over a bucketed time axis. */
export function TimeChart({ buckets, bucketMs, onSelectBucket, ...rest }: TimeChartProps) {
	const locale = useLocale();
	return (
		<Chart
			{...rest}
			slots={buckets.length}
			tickLabel={i => formatTick(buckets[i], bucketMs, locale)}
			tooltipTitle={i => formatBucket(buckets[i], bucketMs, locale)}
			onSelect={onSelectBucket ? i => onSelectBucket(buckets[i]) : undefined}
		/>
	);
}

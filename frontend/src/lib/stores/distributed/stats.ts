import { derived, readable, writable } from 'svelte/store';
import { LoadStats } from '$lib/wailsjs/go/main/App';
import { browser } from '$app/environment';
import type { TreeMapDatum, TreeMapLastChild } from '$lib/viz/tree/types';
export type BaseStats = Record<
  string,
  { hits: number; seconds: number; op_stats?: Record<string, { time: number; bytes: bigint }> }
>;
type ModelStats = Record<string, unknown> & { statistics: BaseStats; bytes_used: bigint };
export type DistTrainingStats = Record<string, ModelStats>;

export type ParsedStats = {
  route_stats: BaseStats;
  bytes_used: Record<string, bigint>;
  timestamp: number;
};

export const ioStats = readable<ParsedStats[]>([], (set) => {
  if (!browser) return;
  const values: ParsedStats[] = [];
  fetchStats()
    .then((data) => {
      const { timestamp } = data;
      values.push(data);
      let treeMapData: TreeMapDatum | undefined = undefined;
      tree_map_data.subscribe((val) => {
        treeMapData = val
      })
      if(treeMapData) updateSnapshots(values, timestamp, treeMapData)
      set(values);
    })
    .catch((err) => console.error(`Failed to fetch stats`, err));

  // query stats endpoints 10 x per second
  const id = setInterval(() => {
    fetchStats()
      .then((data) => {
        const { timestamp } = data;
        values.push(data);
        let treeMapData: TreeMapDatum | undefined = undefined;
        tree_map_data.subscribe((val) => {
          treeMapData = val
        })
        if(treeMapData) updateSnapshots(values, timestamp, treeMapData)
        set(values);
      })
      .catch((err) => console.error(`Failed to fetch`, err));
  }, 100);

  return () => {
    clearInterval(id);
  };
});

const updateSnapshots = (ioStats: ParsedStats[], timestamp: number, treeMapData: TreeMapDatum) => {
  let v: Map<number, { ioStats: ParsedStats[]; treeMapData: TreeMapDatum }> = new Map()
  snapshots.subscribe((val) => {
    v = val
  })
  v.set(timestamp, { ioStats, treeMapData })
  snapshots.set(v)
}
export const snapshots = writable<Map<number, { ioStats: ParsedStats[]; treeMapData: TreeMapDatum }>>(new Map())

export const treeMapDatum = writable<
  Record<string, Record<string, { time: number; bytes: number }>>
>({});

export const tree_map_data = derived(treeMapDatum, ($treeMapDatum) => {
  let treeMapData: TreeMapDatum = { name: 'Distributed Training', children: [] };
  tree_map_data.subscribe((val) => {
    if (val) treeMapData = val;
  });
  Object.entries($treeMapDatum).forEach((val) => {
    // console.log(val);
    const [key, value] = val;
    const key_split = key.split(' ');
    const model_name = key_split.length > 1 ? `Model - ${key_split[0]}` : 'Model - (HOST)';
    const route_name =
      key_split.length > 1 ? `Route - "${key_split[1]}"` : `Route - "${key_split[0]}"`;

    let modelIdx = treeMapData.children.findIndex((x) => x.name === model_name);
    if (modelIdx === -1) {
      (treeMapData.children as TreeMapDatum[]).push({
        name: model_name,
        children: []
      });
      modelIdx = treeMapData.children.length - 1;
    }

    let route_idx = (
      (treeMapData.children as TreeMapDatum[])[modelIdx].children as TreeMapDatum[]
    ).findIndex((x) => x.name === route_name);

    if (route_idx === -1) {
      ((treeMapData.children as TreeMapDatum[])[modelIdx].children as TreeMapDatum[]).push({
        name: route_name,
        children: []
      });
      route_idx =
        ((treeMapData.children as TreeMapDatum[])[modelIdx].children as TreeMapDatum[]).length - 1;
    }

    for (const [op_key, op_vals] of Object.entries(value)) {
      const op_name = op_key.split('@')[0];
      const op_idx = (
        ((treeMapData.children as TreeMapDatum[])[modelIdx].children as TreeMapDatum[])[route_idx]
          .children as TreeMapLastChild[]
      ).findIndex((op) => op.name === op_name);
      if (op_idx === -1) {
        (
          ((treeMapData.children as TreeMapDatum[])[modelIdx].children as TreeMapDatum[])[route_idx]
            .children as TreeMapLastChild[]
        ).push({
          name: op_name,
          value: op_vals.time,
          other_data: {
            bytes: op_vals.bytes
          }
        });
      } else {
        (
          ((treeMapData.children as TreeMapDatum[])[modelIdx].children as TreeMapDatum[])[route_idx]
            .children as TreeMapLastChild[]
        )[op_idx].value = op_vals.time;

        (
          ((treeMapData.children as TreeMapDatum[])[modelIdx].children as TreeMapDatum[])[route_idx]
            .children as TreeMapLastChild[]
        )[op_idx].other_data = {
          bytes: op_vals.bytes
        };
      }
    }
  });
  return treeMapData;
});

const fetchStats = () => {
  return LoadStats('http://127.0.0.1:3000/statistics').then((stats) => {
    const { route_stats, bytes_used } = <{ route_stats: BaseStats; bytes_used: Record<string, bigint>;}>JSON.parse(stats);
    for (const [key, value] of Object.entries(route_stats)) {
      updateTreeMap(value, key)
    }
    const timestamp = new Date().getTime();
    return { route_stats, bytes_used, timestamp };
  });
};

const updateTreeMap = (stats: {
    hits: number;
    seconds: number;
    op_stats?: Record<string, {
        time: number;
        bytes: bigint;
    }>;
}, used_key: string) => {
      const new_stats = stats.op_stats;
      if (new_stats) {
        let v: Record<string, Record<string, { time: number; bytes: number }>> = {};
        treeMapDatum.subscribe((val) => {
          v = val;
        });
        if (!v[used_key]) {
          v[used_key] = {};
          const new_keys = Object.keys(new_stats);
          for (const k of new_keys) {
            v[used_key][k] = {
              time: new_stats[k].time,
              bytes: Number(new_stats[k].bytes)
            };
          }
        } else {
          const new_keys = Object.keys(new_stats);
          for (const k of new_keys) {
            if (!v[used_key][k]) {
              v[used_key][k] = {
                time: new_stats[k].time,
                bytes: Number(new_stats[k].bytes)
              };
            } else {
              const { time, bytes } = v[used_key][k];
              v[used_key][k].time = time * 0.1 + new_stats[k].time * 0.9;
              v[used_key][k].bytes = Number(bytes) * 0.1 + Number(new_stats[k].bytes) * 0.9;
            }
          }
        }
        treeMapDatum.set(v);
      }
  
};

const parseStats = async (stats: { route_stats: BaseStats; bytes_used: Record<string, bigint>; }) => {
  const { route_stats, bytes_used } = stats;
  return { route_stats, bytes_used };
};

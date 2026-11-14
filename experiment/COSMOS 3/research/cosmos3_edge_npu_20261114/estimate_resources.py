"""Configuration-based estimates only; this does not execute Cosmos or an NPU."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    # Only the numerical fields required by these formulas are shipped.
    # Full third-party source/config caches are deliberately excluded.
    inputs = json.loads((ROOT / 'estimator_inputs.json').read_text())
    text = inputs['text_config']
    gen = inputs['generator_config']
    vae = inputs['vae_config']
    idx = {'metadata': {'total_size': inputs['transformer_weight_bytes_from_index']}}
    L, D, I = gen['num_hidden_layers'], gen['hidden_size'], gen['intermediate_size']
    H, Hkv, d = gen['num_attention_heads'], gen['num_key_value_heads'], gen['head_dim']
    cases = []
    for width, height, frames in [(320, 192, 53), (832, 480, 53), (832, 480, 149)]:
        assert width % vae['scale_factor_spatial'] == 0
        assert height % vae['scale_factor_spatial'] == 0
        assert (frames - 1) % vae['scale_factor_temporal'] == 0
        tl = (frames - 1) // vae['scale_factor_temporal'] + 1
        hl, wl = height // vae['scale_factor_spatial'], width // vae['scale_factor_spatial']
        p = gen['latent_patch_size']
        assert hl % p == 0 and wl % p == 0
        N = tl * (hl // p) * (wl // p)
        # Two bytes per BF16 element. These are separate tensors, not a total peak.
        cases.append({
            'width': width, 'height': height, 'frames': frames,
            'latent_shape_C_T_H_W': [gen['latent_channel'], tl, hl, wl],
            'visual_tokens': N,
            'one_hidden_tensor_bytes': 2 * N * D,
            'one_ffn_intermediate_bytes': 2 * N * I,
            'naive_gen_self_attention_scores_bytes': 2 * H * N * N,
            'naive_gen_attention_scores_with_128_AR_tokens_bytes': 2 * H * N * (N + 128),
            'one_gen_tower_step_approx_flops': L * (
                2 * N * (2 * D * D + 2 * D * Hkv * d) + 4 * N * D * I + 4 * N * N * D
            ),
        })
    result = {
        'result_kind': 'estimate',
        'npu_execution': 'not_run',
        'assumptions': [
            'B=1; BF16 storage; frames=4k+1; spatial compression=16; spatial latent patch=2.',
            'Attention-score sizes assume full materialization; tiled attention avoids that allocation.',
            'FLOPs count one generator tower pass; no AR, vision, VAE, CFG, or scheduler overhead.',
            'A multiply-add counts as two FLOPs. These are not TOPS-based speed predictions.',
            'Individual tensor sizes are not runtime peak memory; allocator/liveness and copies are unknown.',
        ],
        'transformer_weight_bytes_from_index': idx['metadata']['total_size'],
        'ideal_4B_weight_bytes': {'BF16': 8_000_000_000, 'INT8': 4_000_000_000, 'INT4': 2_000_000_000},
        'bf16_reasoner_KV_bytes': {str(S): 2 * text['num_hidden_layers'] * S * text['num_key_value_heads'] * text['head_dim'] * 2
                                   for S in [2048, 8192, 32768, 131072]},
        'one_FFN_BF16_weight_bytes': 2 * 2 * D * I,
        'cases': cases,
    }
    (ROOT / 'resource_estimates.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

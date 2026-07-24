// Clean-room ESSL implementation of Blender's normalized 3D FBM Noise Texture.
//
// The integer lookup3 hash, 3D gradient selection, 0.982 scale, inclusive
// Detail octave count, and normalized 0.5-centered output mirror the portable
// CPU/GLSL oracle already used by the authored WebGL material adapters.
// This source is injected only for MaterialX fractal3d nodes whose names begin
// with `blender_fbm3_`; ordinary MaterialX fractal3d semantics are untouched.

uint mx_blender_rotl(uint value, uint amount)
{
    return (value << amount) | (value >> (32u - amount));
}

uvec3 mx_blender_finalize_hash(uvec3 value)
{
    value.z = (value.z ^ value.y) - mx_blender_rotl(value.y, 14u);
    value.x = (value.x ^ value.z) - mx_blender_rotl(value.z, 11u);
    value.y = (value.y ^ value.x) - mx_blender_rotl(value.x, 25u);
    value.z = (value.z ^ value.y) - mx_blender_rotl(value.y, 16u);
    value.x = (value.x ^ value.z) - mx_blender_rotl(value.z, 4u);
    value.y = (value.y ^ value.x) - mx_blender_rotl(value.x, 14u);
    value.z = (value.z ^ value.y) - mx_blender_rotl(value.y, 24u);
    return value;
}

uint mx_blender_hash3(uvec3 key)
{
    return mx_blender_finalize_hash(uvec3(0xdeadbeefu + 12u + 13u) + key).z;
}

float mx_blender_fade(float value)
{
    return value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
}

float mx_blender_gradient(uint hash, vec3 point)
{
    uint h = hash & 15u;
    float u = h < 8u ? point.x : point.y;
    float v = h < 4u ? point.y : ((h == 12u || h == 14u) ? point.x : point.z);
    return ((h & 1u) != 0u ? -u : u) + ((h & 2u) != 0u ? -v : v);
}

float mx_blender_signed_noise3(vec3 point)
{
    ivec3 cell = ivec3(floor(point));
    vec3 local = fract(point);
    vec3 weight = vec3(
        mx_blender_fade(local.x),
        mx_blender_fade(local.y),
        mx_blender_fade(local.z)
    );
    float n000 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(0, 0, 0))), local - vec3(0, 0, 0));
    float n100 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(1, 0, 0))), local - vec3(1, 0, 0));
    float n010 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(0, 1, 0))), local - vec3(0, 1, 0));
    float n110 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(1, 1, 0))), local - vec3(1, 1, 0));
    float n001 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(0, 0, 1))), local - vec3(0, 0, 1));
    float n101 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(1, 0, 1))), local - vec3(1, 0, 1));
    float n011 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(0, 1, 1))), local - vec3(0, 1, 1));
    float n111 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(1, 1, 1))), local - vec3(1, 1, 1));
    return 0.982 * mix(
        mix(mix(n000, n100, weight.x), mix(n010, n110, weight.x), weight.y),
        mix(mix(n001, n101, weight.x), mix(n011, n111, weight.x), weight.y),
        weight.z
    );
}

void mx_blender_fbm3_float(
    float amplitude,
    int octaves,
    float lacunarity,
    float diminish,
    vec3 position,
    out float result)
{
    float sum = 0.0;
    float maximum = 0.0;
    float current_amplitude = amplitude;
    float frequency = 1.0;
    for (int octave = 0; octave < 16; ++octave)
    {
        if (octave >= octaves)
        {
            break;
        }
        sum += current_amplitude * mx_blender_signed_noise3(position * frequency);
        maximum += current_amplitude;
        current_amplitude *= max(diminish, 0.0);
        frequency *= lacunarity;
    }
    result = maximum > 0.0 ? 0.5 * sum / maximum + 0.5 : 0.5;
}

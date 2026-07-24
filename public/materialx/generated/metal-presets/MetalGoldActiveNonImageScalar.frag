#version 300 es

precision highp float;
precision highp int;


struct BSDF { vec3 response; vec3 throughput; };
#define EDF vec3
struct surfaceshader { vec3 color; vec3 transparency; };
struct volumeshader { vec3 color; vec3 transparency; };
struct displacementshader { vec3 offset; float scale; };
struct lightshader { vec3 intensity; vec3 direction; };
#define material surfaceshader

// Uniform block: PrivateUniforms
uniform mat4 u_envMatrix;
uniform sampler2D u_envRadiance;
uniform float u_envLightIntensity;
uniform int u_envRadianceMips;
uniform int u_envRadianceSamples;
uniform sampler2D u_envIrradiance;
uniform bool u_refractionTwoSided;
uniform vec3 u_viewPosition;
uniform mat4 u_worldInverseTransposeMatrix;
uniform int u_numActiveLightSources;

// Uniform block: PublicUniforms
uniform surfaceshader backsurfaceshader;
uniform displacementshader displacementshader1;
uniform vec3 generated_extent_in1;
uniform vec3 generated_extent_in2;
uniform int normal_world_fromspace;
uniform int normal_world_tospace;
uniform vec3 generated_offset_in2;
uniform vec3 generated_safe_extent_in2;
uniform vec3 mapping_scale_in2;
uniform float g_squared_in2;
uniform float length_mix_mix;
uniform float noise_position_in2;
uniform float blender_fbm3_gold_brushed_noise_amplitude;
uniform int blender_fbm3_gold_brushed_noise_octaves;
uniform float blender_fbm3_gold_brushed_noise_lacunarity;
uniform float blender_fbm3_gold_brushed_noise_diminish;
uniform float b_denominator_in2;
uniform float b_numerator_in2;
uniform float brushed_gate_unclamped_inlow;
uniform float brushed_gate_unclamped_inhigh;
uniform float brushed_gate_unclamped_outlow;
uniform float brushed_gate_unclamped_outhigh;
uniform float half_a_squared_in1;
uniform float brushed_gate_low;
uniform float brushed_gate_high;
uniform float one_plus_b_squared_in1;
uniform float brushed_add_in1;
uniform float one_minus_brushed_add_in1;
uniform float one_minus_fresnel_in1;
uniform float lut_scaled_factor_in2;
uniform float lut_centered_factor_in2;
uniform float lut_uv_in2;
uniform sampler2D curve_ramp_response_file;
uniform int curve_ramp_response_layer;
uniform float curve_ramp_response_default;
uniform int curve_ramp_response_uaddressmode;
uniform int curve_ramp_response_vaddressmode;
uniform int curve_ramp_response_filtertype;
uniform int curve_ramp_response_framerange;
uniform int curve_ramp_response_frameoffset;
uniform int curve_ramp_response_frameendaction;
uniform vec2 curve_ramp_response_uv_scale;
uniform vec2 curve_ramp_response_uv_offset;
uniform float authored_base_roughness_in1;
uniform float one_minus_base_roughness_in1;
uniform float perceptual_roughness_in1;
uniform float active_perceptual_roughness_in2;
uniform float surface_gold_active_non_image_scalar_emission;
uniform float surface_gold_active_non_image_scalar_transmission;
uniform vec3 surface_gold_active_non_image_scalar_transmission_color;
uniform float surface_gold_active_non_image_scalar_opacity;

in vec3 normalObject;
in vec3 positionWorld;
in vec3 positionObject;

// Pixel shader outputs
out vec4 out1;

#define M_FLOAT_EPS 1e-8

#define mx_mod mod
#define mx_inverse inverse
#define mx_inversesqrt inversesqrt
#define mx_sin sin
#define mx_cos cos
#define mx_tan tan
#define mx_asin asin
#define mx_acos acos
#define mx_atan atan
#define mx_radians radians

float mx_square(float x)
{
    return x*x;
}

vec2 mx_square(vec2 x)
{
    return x*x;
}

vec3 mx_square(vec3 x)
{
    return x*x;
}

vec3 mx_srgb_encode(vec3 color)
{
    bvec3 isAbove = greaterThan(color, vec3(0.0031308));
    vec3 linSeg = color * 12.92;
    vec3 powSeg = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(linSeg, powSeg, isAbove);
}

void NG_convert_float_vector3(float in1, out vec3 out1)
{
    vec3 combine_out = vec3(in1,in1,in1);
    out1 = combine_out;
}

/*
Noise Library.

This library is a modified version of the noise library found in
Open Shading Language:
github.com/imageworks/OpenShadingLanguage/blob/master/src/include/OSL/oslnoise.h

It contains the subset of noise types needed to implement the MaterialX
standard library. The modifications are mainly conversions from C++ to GLSL.
Produced results should be identical to the OSL noise functions.

Original copyright notice:
------------------------------------------------------------------------
Copyright (c) 2009-2010 Sony Pictures Imageworks Inc., et al.
All Rights Reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:
* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of Sony Pictures Imageworks nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
------------------------------------------------------------------------
*/

float mx_select(bool b, float t, float f)
{
    return b ? t : f;
}

float mx_negate_if(float val, bool b)
{
    return b ? -val : val;
}

int mx_floor(float x)
{
    return int(floor(x));
}

// return mx_floor as well as the fractional remainder
float mx_floorfrac(float x, out int i)
{
    i = mx_floor(x);
    return x - float(i);
}

float mx_bilerp(float v0, float v1, float v2, float v3, float s, float t)
{
    float s1 = 1.0 - s;
    return (1.0 - t) * (v0*s1 + v1*s) + t * (v2*s1 + v3*s);
}
vec3 mx_bilerp(vec3 v0, vec3 v1, vec3 v2, vec3 v3, float s, float t)
{
    float s1 = 1.0 - s;
    return (1.0 - t) * (v0*s1 + v1*s) + t * (v2*s1 + v3*s);
}
float mx_trilerp(float v0, float v1, float v2, float v3, float v4, float v5, float v6, float v7, float s, float t, float r)
{
    float s1 = 1.0 - s;
    float t1 = 1.0 - t;
    float r1 = 1.0 - r;
    return (r1*(t1*(v0*s1 + v1*s) + t*(v2*s1 + v3*s)) +
            r*(t1*(v4*s1 + v5*s) + t*(v6*s1 + v7*s)));
}
vec3 mx_trilerp(vec3 v0, vec3 v1, vec3 v2, vec3 v3, vec3 v4, vec3 v5, vec3 v6, vec3 v7, float s, float t, float r)
{
    float s1 = 1.0 - s;
    float t1 = 1.0 - t;
    float r1 = 1.0 - r;
    return (r1*(t1*(v0*s1 + v1*s) + t*(v2*s1 + v3*s)) +
            r*(t1*(v4*s1 + v5*s) + t*(v6*s1 + v7*s)));
}

// 2 and 3 dimensional gradient functions - perform a dot product against a
// randomly chosen vector. Note that the gradient vector is not normalized, but
// this only affects the overall "scale" of the result, so we simply account for
// the scale by multiplying in the corresponding "perlin" function.
float mx_gradient_float(uint hash, float x, float y)
{
    // 8 possible directions (+-1,+-2) and (+-2,+-1)
    uint h = hash & 7u;
    float u = mx_select(h<4u, x, y);
    float v = 2.0 * mx_select(h<4u, y, x);
    // compute the dot product with (x,y).
    return mx_negate_if(u, bool(h&1u)) + mx_negate_if(v, bool(h&2u));
}
float mx_gradient_float(uint hash, float x, float y, float z)
{
    // use vectors pointing to the edges of the cube
    uint h = hash & 15u;
    float u = mx_select(h<8u, x, y);
    float v = mx_select(h<4u, y, mx_select((h==12u)||(h==14u), x, z));
    return mx_negate_if(u, bool(h&1u)) + mx_negate_if(v, bool(h&2u));
}
vec3 mx_gradient_vec3(uvec3 hash, float x, float y)
{
    return vec3(mx_gradient_float(hash.x, x, y), mx_gradient_float(hash.y, x, y), mx_gradient_float(hash.z, x, y));
}
vec3 mx_gradient_vec3(uvec3 hash, float x, float y, float z)
{
    return vec3(mx_gradient_float(hash.x, x, y, z), mx_gradient_float(hash.y, x, y, z), mx_gradient_float(hash.z, x, y, z));
}
// Scaling factors to normalize the result of gradients above.
// These factors were experimentally calculated to be:
//    2D:   0.6616
//    3D:   0.9820
float mx_gradient_scale2d(float v) { return 0.6616 * v; }
float mx_gradient_scale3d(float v) { return 0.9820 * v; }
vec3 mx_gradient_scale2d(vec3 v) { return 0.6616 * v; }
vec3 mx_gradient_scale3d(vec3 v) { return 0.9820 * v; }

/// Bitwise circular rotation left by k bits (for 32 bit unsigned integers)
uint mx_rotl32(uint x, int k)
{
    return (x<<k) | (x>>(32-k));
}

void mx_bjmix(inout uint a, inout uint b, inout uint c)
{
    a -= c; a ^= mx_rotl32(c, 4); c += b;
    b -= a; b ^= mx_rotl32(a, 6); a += c;
    c -= b; c ^= mx_rotl32(b, 8); b += a;
    a -= c; a ^= mx_rotl32(c,16); c += b;
    b -= a; b ^= mx_rotl32(a,19); a += c;
    c -= b; c ^= mx_rotl32(b, 4); b += a;
}

// Mix up and combine the bits of a, b, and c (doesn't change them, but
// returns a hash of those three original values).
uint mx_bjfinal(uint a, uint b, uint c)
{
    c ^= b; c -= mx_rotl32(b,14);
    a ^= c; a -= mx_rotl32(c,11);
    b ^= a; b -= mx_rotl32(a,25);
    c ^= b; c -= mx_rotl32(b,16);
    a ^= c; a -= mx_rotl32(c,4);
    b ^= a; b -= mx_rotl32(a,14);
    c ^= b; c -= mx_rotl32(b,24);
    return c;
}

// Convert a 32 bit integer into a floating point number in [0,1]
float mx_bits_to_01(uint bits)
{
    return float(bits) / float(uint(0xffffffff));
}

float mx_fade(float t)
{
   return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

uint mx_hash_int(int x)
{
    uint len = 1u;
    uint seed = uint(0xdeadbeef) + (len << 2u) + 13u;
    return mx_bjfinal(seed+uint(x), seed, seed);
}

uint mx_hash_int(int x, int y)
{
    uint len = 2u;
    uint a, b, c;
    a = b = c = uint(0xdeadbeef) + (len << 2u) + 13u;
    a += uint(x);
    b += uint(y);
    return mx_bjfinal(a, b, c);
}

uint mx_hash_int(int x, int y, int z)
{
    uint len = 3u;
    uint a, b, c;
    a = b = c = uint(0xdeadbeef) + (len << 2u) + 13u;
    a += uint(x);
    b += uint(y);
    c += uint(z);
    return mx_bjfinal(a, b, c);
}

uint mx_hash_int(int x, int y, int z, int xx)
{
    uint len = 4u;
    uint a, b, c;
    a = b = c = uint(0xdeadbeef) + (len << 2u) + 13u;
    a += uint(x);
    b += uint(y);
    c += uint(z);
    mx_bjmix(a, b, c);
    a += uint(xx);
    return mx_bjfinal(a, b, c);
}

uint mx_hash_int(int x, int y, int z, int xx, int yy)
{
    uint len = 5u;
    uint a, b, c;
    a = b = c = uint(0xdeadbeef) + (len << 2u) + 13u;
    a += uint(x);
    b += uint(y);
    c += uint(z);
    mx_bjmix(a, b, c);
    a += uint(xx);
    b += uint(yy);
    return mx_bjfinal(a, b, c);
}

uvec3 mx_hash_vec3(int x, int y)
{
    uint h = mx_hash_int(x, y);
    // we only need the low-order bits to be random, so split out
    // the 32 bit result into 3 parts for each channel
    uvec3 result;
    result.x = (h      ) & 0xFFu;
    result.y = (h >> 8 ) & 0xFFu;
    result.z = (h >> 16) & 0xFFu;
    return result;
}

uvec3 mx_hash_vec3(int x, int y, int z)
{
    uint h = mx_hash_int(x, y, z);
    // we only need the low-order bits to be random, so split out
    // the 32 bit result into 3 parts for each channel
    uvec3 result;
    result.x = (h      ) & 0xFFu;
    result.y = (h >> 8 ) & 0xFFu;
    result.z = (h >> 16) & 0xFFu;
    return result;
}

float mx_perlin_noise_float(vec2 p)
{
    int X, Y;
    float fx = mx_floorfrac(p.x, X);
    float fy = mx_floorfrac(p.y, Y);
    float u = mx_fade(fx);
    float v = mx_fade(fy);
    float result = mx_bilerp(
        mx_gradient_float(mx_hash_int(X  , Y  ), fx    , fy     ),
        mx_gradient_float(mx_hash_int(X+1, Y  ), fx-1.0, fy     ),
        mx_gradient_float(mx_hash_int(X  , Y+1), fx    , fy-1.0),
        mx_gradient_float(mx_hash_int(X+1, Y+1), fx-1.0, fy-1.0),
        u, v);
    return mx_gradient_scale2d(result);
}

float mx_perlin_noise_float(vec3 p)
{
    int X, Y, Z;
    float fx = mx_floorfrac(p.x, X);
    float fy = mx_floorfrac(p.y, Y);
    float fz = mx_floorfrac(p.z, Z);
    float u = mx_fade(fx);
    float v = mx_fade(fy);
    float w = mx_fade(fz);
    float result = mx_trilerp(
        mx_gradient_float(mx_hash_int(X  , Y  , Z  ), fx    , fy    , fz     ),
        mx_gradient_float(mx_hash_int(X+1, Y  , Z  ), fx-1.0, fy    , fz     ),
        mx_gradient_float(mx_hash_int(X  , Y+1, Z  ), fx    , fy-1.0, fz     ),
        mx_gradient_float(mx_hash_int(X+1, Y+1, Z  ), fx-1.0, fy-1.0, fz     ),
        mx_gradient_float(mx_hash_int(X  , Y  , Z+1), fx    , fy    , fz-1.0),
        mx_gradient_float(mx_hash_int(X+1, Y  , Z+1), fx-1.0, fy    , fz-1.0),
        mx_gradient_float(mx_hash_int(X  , Y+1, Z+1), fx    , fy-1.0, fz-1.0),
        mx_gradient_float(mx_hash_int(X+1, Y+1, Z+1), fx-1.0, fy-1.0, fz-1.0),
        u, v, w);
    return mx_gradient_scale3d(result);
}

vec3 mx_perlin_noise_vec3(vec2 p)
{
    int X, Y;
    float fx = mx_floorfrac(p.x, X);
    float fy = mx_floorfrac(p.y, Y);
    float u = mx_fade(fx);
    float v = mx_fade(fy);
    vec3 result = mx_bilerp(
        mx_gradient_vec3(mx_hash_vec3(X  , Y  ), fx    , fy     ),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y  ), fx-1.0, fy     ),
        mx_gradient_vec3(mx_hash_vec3(X  , Y+1), fx    , fy-1.0),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y+1), fx-1.0, fy-1.0),
        u, v);
    return mx_gradient_scale2d(result);
}

vec3 mx_perlin_noise_vec3(vec3 p)
{
    int X, Y, Z;
    float fx = mx_floorfrac(p.x, X);
    float fy = mx_floorfrac(p.y, Y);
    float fz = mx_floorfrac(p.z, Z);
    float u = mx_fade(fx);
    float v = mx_fade(fy);
    float w = mx_fade(fz);
    vec3 result = mx_trilerp(
        mx_gradient_vec3(mx_hash_vec3(X  , Y  , Z  ), fx    , fy    , fz     ),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y  , Z  ), fx-1.0, fy    , fz     ),
        mx_gradient_vec3(mx_hash_vec3(X  , Y+1, Z  ), fx    , fy-1.0, fz     ),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y+1, Z  ), fx-1.0, fy-1.0, fz     ),
        mx_gradient_vec3(mx_hash_vec3(X  , Y  , Z+1), fx    , fy    , fz-1.0),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y  , Z+1), fx-1.0, fy    , fz-1.0),
        mx_gradient_vec3(mx_hash_vec3(X  , Y+1, Z+1), fx    , fy-1.0, fz-1.0),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y+1, Z+1), fx-1.0, fy-1.0, fz-1.0),
        u, v, w);
    return mx_gradient_scale3d(result);
}

float mx_cell_noise_float(float p)
{
    int ix = mx_floor(p);
    return mx_bits_to_01(mx_hash_int(ix));
}

float mx_cell_noise_float(vec2 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    return mx_bits_to_01(mx_hash_int(ix, iy));
}

float mx_cell_noise_float(vec3 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    int iz = mx_floor(p.z);
    return mx_bits_to_01(mx_hash_int(ix, iy, iz));
}

float mx_cell_noise_float(vec4 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    int iz = mx_floor(p.z);
    int iw = mx_floor(p.w);
    return mx_bits_to_01(mx_hash_int(ix, iy, iz, iw));
}

vec3 mx_cell_noise_vec3(float p)
{
    int ix = mx_floor(p);
    return vec3(
            mx_bits_to_01(mx_hash_int(ix, 0)),
            mx_bits_to_01(mx_hash_int(ix, 1)),
            mx_bits_to_01(mx_hash_int(ix, 2))
    );
}

vec3 mx_cell_noise_vec3(vec2 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    return vec3(
            mx_bits_to_01(mx_hash_int(ix, iy, 0)),
            mx_bits_to_01(mx_hash_int(ix, iy, 1)),
            mx_bits_to_01(mx_hash_int(ix, iy, 2))
    );
}

vec3 mx_cell_noise_vec3(vec3 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    int iz = mx_floor(p.z);
    return vec3(
            mx_bits_to_01(mx_hash_int(ix, iy, iz, 0)),
            mx_bits_to_01(mx_hash_int(ix, iy, iz, 1)),
            mx_bits_to_01(mx_hash_int(ix, iy, iz, 2))
    );
}

vec3 mx_cell_noise_vec3(vec4 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    int iz = mx_floor(p.z);
    int iw = mx_floor(p.w);
    return vec3(
            mx_bits_to_01(mx_hash_int(ix, iy, iz, iw, 0)),
            mx_bits_to_01(mx_hash_int(ix, iy, iz, iw, 1)),
            mx_bits_to_01(mx_hash_int(ix, iy, iz, iw, 2))
    );
}

float mx_fractal2d_noise_float(vec2 p, int octaves, float lacunarity, float diminish)
{
    float result = 0.0;
    float amplitude = 1.0;
    for (int i = 0;  i < octaves; ++i)
    {
        result += amplitude * mx_perlin_noise_float(p);
        amplitude *= diminish;
        p *= lacunarity;
    }
    return result;
}

vec3 mx_fractal2d_noise_vec3(vec2 p, int octaves, float lacunarity, float diminish)
{
    vec3 result = vec3(0.0);
    float amplitude = 1.0;
    for (int i = 0;  i < octaves; ++i)
    {
        result += amplitude * mx_perlin_noise_vec3(p);
        amplitude *= diminish;
        p *= lacunarity;
    }
    return result;
}

vec2 mx_fractal2d_noise_vec2(vec2 p, int octaves, float lacunarity, float diminish)
{
    return vec2(mx_fractal2d_noise_float(p, octaves, lacunarity, diminish),
                mx_fractal2d_noise_float(p+vec2(19, 193), octaves, lacunarity, diminish));
}

vec4 mx_fractal2d_noise_vec4(vec2 p, int octaves, float lacunarity, float diminish)
{
    vec3  c = mx_fractal2d_noise_vec3(p, octaves, lacunarity, diminish);
    float f = mx_fractal2d_noise_float(p+vec2(19, 193), octaves, lacunarity, diminish);
    return vec4(c, f);
}

float mx_fractal3d_noise_float(vec3 p, int octaves, float lacunarity, float diminish)
{
    float result = 0.0;
    float amplitude = 1.0;
    for (int i = 0;  i < octaves; ++i)
    {
        result += amplitude * mx_perlin_noise_float(p);
        amplitude *= diminish;
        p *= lacunarity;
    }
    return result;
}

vec3 mx_fractal3d_noise_vec3(vec3 p, int octaves, float lacunarity, float diminish)
{
    vec3 result = vec3(0.0);
    float amplitude = 1.0;
    for (int i = 0;  i < octaves; ++i)
    {
        result += amplitude * mx_perlin_noise_vec3(p);
        amplitude *= diminish;
        p *= lacunarity;
    }
    return result;
}

vec2 mx_fractal3d_noise_vec2(vec3 p, int octaves, float lacunarity, float diminish)
{
    return vec2(mx_fractal3d_noise_float(p, octaves, lacunarity, diminish),
                mx_fractal3d_noise_float(p+vec3(19, 193, 17), octaves, lacunarity, diminish));
}

vec4 mx_fractal3d_noise_vec4(vec3 p, int octaves, float lacunarity, float diminish)
{
    vec3  c = mx_fractal3d_noise_vec3(p, octaves, lacunarity, diminish);
    float f = mx_fractal3d_noise_float(p+vec3(19, 193, 17), octaves, lacunarity, diminish);
    return vec4(c, f);
}

vec2 mx_worley_cell_position(int x, int y, int xoff, int yoff, float jitter)
{
    vec3  tmp = mx_cell_noise_vec3(vec2(x+xoff, y+yoff));
    vec2  off = vec2(tmp.x, tmp.y);

    off -= 0.5f;
    off *= jitter;
    off += 0.5f;

    return vec2(float(x), float(y)) + off;
}

vec3 mx_worley_cell_position(int x, int y, int z, int xoff, int yoff, int zoff, float jitter)
{
    vec3  off = mx_cell_noise_vec3(vec3(x+xoff, y+yoff, z+zoff));

    off -= 0.5f;
    off *= jitter;
    off += 0.5f;

    return vec3(float(x), float(y), float(z)) + off;
}

float mx_worley_distance(vec2 p, int x, int y, int xoff, int yoff, float jitter, int metric)
{
    vec2 cellpos = mx_worley_cell_position(x, y, xoff, yoff, jitter);
    vec2 diff = cellpos - p;
    if (metric == 2)
        return abs(diff.x) + abs(diff.y);       // Manhattan distance
    if (metric == 3)
        return max(abs(diff.x), abs(diff.y));   // Chebyshev distance
    // Either Euclidean or Distance^2
    return dot(diff, diff);
}

float mx_worley_distance(vec3 p, int x, int y, int z, int xoff, int yoff, int zoff, float jitter, int metric)
{
    vec3 cellpos = mx_worley_cell_position(x, y, z, xoff, yoff, zoff, jitter);
    vec3 diff = cellpos - p;
    if (metric == 2)
        return abs(diff.x) + abs(diff.y) + abs(diff.z); // Manhattan distance
    if (metric == 3)
        return max(max(abs(diff.x), abs(diff.y)), abs(diff.z)); // Chebyshev distance
    // Either Euclidean or Distance^2
    return dot(diff, diff);
}

float mx_worley_noise_float(vec2 p, float jitter, int style, int metric)
{
    int X, Y;
    float dist;
    vec2 localpos = vec2(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y));
    float sqdist = 1e6f;        // Some big number for jitter > 1 (not all GPUs may be IEEE)
    vec2 minpos = vec2(0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            float dist = mx_worley_distance(localpos, x, y, X, Y, jitter, metric);
            vec2 cellpos = mx_worley_cell_position(x, y, X, Y, jitter) - localpos;
            if(dist < sqdist)
            {
                sqdist = dist;
                minpos = cellpos;
            }
        }
    }
    if (style == 1)
        return mx_cell_noise_float(minpos + p);
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

vec2 mx_worley_noise_vec2(vec2 p, float jitter, int style, int metric)
{
    int X, Y;
    vec2 localpos = vec2(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y));
    vec2 sqdist = vec2(1e6f, 1e6f);
    vec2 minpos = vec2(0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            float dist = mx_worley_distance(localpos, x, y, X, Y, jitter, metric);
            vec2 cellpos = mx_worley_cell_position(x, y, X, Y, jitter) - localpos;
            if (dist < sqdist.x)
            {
                sqdist.y = sqdist.x;
                sqdist.x = dist;
                minpos = cellpos;
            }
            else if (dist < sqdist.y)
            {
                sqdist.y = dist;
            }
        }
    }
    if (style == 1)
    {
        vec3 tmp = mx_cell_noise_vec3(minpos + p);
        return vec2(tmp.x,tmp.y);
    }
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

vec3 mx_worley_noise_vec3(vec2 p, float jitter, int style, int metric)
{
    int X, Y;
    vec2 localpos = vec2(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y));
    vec3 sqdist = vec3(1e6f, 1e6f, 1e6f);
    vec2 minpos = vec2(0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            float dist = mx_worley_distance(localpos, x, y, X, Y, jitter, metric);
            vec2 cellpos = mx_worley_cell_position(x, y, X, Y, jitter) - localpos;
            if (dist < sqdist.x)
            {
                sqdist.z = sqdist.y;
                sqdist.y = sqdist.x;
                sqdist.x = dist;
                minpos = cellpos;
            }
            else if (dist < sqdist.y)
            {
                sqdist.z = sqdist.y;
                sqdist.y = dist;
            }
            else if (dist < sqdist.z)
            {
                sqdist.z = dist;
            }
        }
    }
    if (style == 1)
        return mx_cell_noise_vec3(minpos + p);
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

float mx_worley_noise_float(vec3 p, float jitter, int style, int metric)
{
    int X, Y, Z;
    vec3 localpos = vec3(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y), mx_floorfrac(p.z, Z));
    float sqdist = 1e6f;
    vec3 minpos = vec3(0,0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            for (int z = -1; z <= 1; ++z)
            {
                float dist = mx_worley_distance(localpos, x, y, z, X, Y, Z, jitter, metric);
                vec3 cellpos = mx_worley_cell_position(x, y, z, X, Y, Z, jitter) - localpos;
                if(dist < sqdist)
                {
                    sqdist = dist;
                    minpos = cellpos;
                }
            }
        }
    }
    if (style == 1)
        return mx_cell_noise_float(minpos + p);
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

vec2 mx_worley_noise_vec2(vec3 p, float jitter, int style, int metric)
{
    int X, Y, Z;
    vec3 localpos = vec3(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y), mx_floorfrac(p.z, Z));
    vec2 sqdist = vec2(1e6f, 1e6f);
    vec3 minpos = vec3(0,0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            for (int z = -1; z <= 1; ++z)
            {
                float dist = mx_worley_distance(localpos, x, y, z, X, Y, Z, jitter, metric);
                vec3 cellpos = mx_worley_cell_position(x, y, z, X, Y, Z, jitter) - localpos;
                if (dist < sqdist.x)
                {
                    sqdist.y = sqdist.x;
                    sqdist.x = dist;
                    minpos = cellpos;
                }
                else if (dist < sqdist.y)
                {
                    sqdist.y = dist;
                }
            }
        }
    }
    if (style == 1)
    {
        vec3 tmp = mx_cell_noise_vec3(minpos + p);
        return vec2(tmp.x,tmp.y);
    }
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

vec3 mx_worley_noise_vec3(vec3 p, float jitter, int style, int metric)
{
    int X, Y, Z;
    vec3 localpos = vec3(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y), mx_floorfrac(p.z, Z));
    vec3 sqdist = vec3(1e6f, 1e6f, 1e6f);
    vec3 minpos = vec3(0,0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            for (int z = -1; z <= 1; ++z)
            {
                float dist = mx_worley_distance(localpos, x, y, z, X, Y, Z, jitter, metric);
                vec3 cellpos = mx_worley_cell_position(x, y, z, X, Y, Z, jitter) - localpos;
                if (dist < sqdist.x)
                {
                    sqdist.z = sqdist.y;
                    sqdist.y = sqdist.x;
                    sqdist.x = dist;
                    minpos = cellpos;
                }
                else if (dist < sqdist.y)
                {
                    sqdist.z = sqdist.y;
                    sqdist.y = dist;
                }
                else if (dist < sqdist.z)
                {
                    sqdist.z = dist;
                }
            }
        }
    }
    if (style == 1)
        return mx_cell_noise_vec3(minpos + p);
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

void mx_fractal3d_float(float amplitude, int octaves, float lacunarity, float diminish, vec3 position, out float result)
{
    float value = mx_fractal3d_noise_float(position, octaves, lacunarity, diminish);
    result = value * amplitude;
}

vec2 mx_transform_uv(vec2 uv, vec2 uv_scale, vec2 uv_offset)
{
    uv = uv * uv_scale + uv_offset;
    return uv;
}

void mx_image_float(sampler2D tex_sampler, int layer, float defaultval, vec2 texcoord, int uaddressmode, int vaddressmode, int filtertype, int framerange, int frameoffset, int frameendaction, vec2 uv_scale, vec2 uv_offset, out float result)
{
    vec2 uv = mx_transform_uv(texcoord, uv_scale, uv_offset);
    result = texture(tex_sampler, uv).r;
}

void NG_convert_float_color3(float in1, out vec3 out1)
{
    vec3 combine_out = vec3(in1,in1,in1);
    out1 = combine_out;
}


void mx_surface_unlit(float emission, vec3 emission_color, float transmission, vec3 transmission_color, float opacity, out surfaceshader result)
{
    result.color = emission * emission_color * opacity;
    result.transparency = mix(vec3(1.0), transmission * transmission_color, opacity);
}

// Clean-room ESSL implementation of Blender's 3D FBM Noise Texture.
//
// The integer lookup3 hash, 3D gradient selection, 0.982 scale, inclusive
// Detail octave count, and normalized/raw output modes mirror the portable
// CPU/GLSL oracle already used by the authored WebGL material adapters. This
// source is injected only for explicitly marked MaterialX fractal3d nodes;
// ordinary MaterialX fractal3d semantics are untouched.

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

void mx_blender_raw_fbm3_float(
    float amplitude,
    int octaves,
    float lacunarity,
    float diminish,
    vec3 position,
    out float result)
{
    result = 0.0;
    float current_amplitude = amplitude;
    float frequency = 1.0;
    for (int octave = 0; octave < 16; ++octave)
    {
        if (octave >= octaves)
        {
            break;
        }
        result += current_amplitude * mx_blender_signed_noise3(position * frequency);
        current_amplitude *= max(diminish, 0.0);
        frequency *= lacunarity;
    }
}

void main()
{
    vec3 normal_object_out = normalize(normalObject);
    vec3 view_world_out = normalize(positionWorld - u_viewPosition);
    vec3 generated_object_position_out = positionObject;
    vec3 generated_extent_out = generated_extent_in1 - generated_extent_in2;
    vec3 normal_world_out = (u_worldInverseTransposeMatrix * vec4(normal_object_out, 0.0)).xyz;
    normal_world_out = normalize(normal_world_out);
    vec3 generated_offset_out = generated_object_position_out - generated_offset_in2;
    vec3 generated_safe_extent_out = max(generated_extent_out, generated_safe_extent_in2);
    float normal_dot_view_out = dot(normal_world_out, view_world_out);
    vec3 generated_coordinate_out = generated_offset_out / generated_safe_extent_out;
    float cosine_out = abs(normal_dot_view_out);
    vec3 mapping_scale_out = generated_coordinate_out * mapping_scale_in2;
    float cosine_squared_out = cosine_out * cosine_out;
    float mapping_length_out = length(mapping_scale_out);
    float g_squared_out = cosine_squared_out + g_squared_in2;
    vec3 mapping_length_vector_out = vec3(0.0);
    NG_convert_float_vector3(mapping_length_out, mapping_length_vector_out);
    float g_out = sqrt(g_squared_out);
    vec3 length_mix_out = mix(mapping_scale_out, mapping_length_vector_out, length_mix_mix);
    float g_minus_cosine_out = g_out - cosine_out;
    float g_plus_cosine_out = g_out + cosine_out;
    vec3 noise_position_out = length_mix_out * noise_position_in2;
    float cosine_g_minus_out = cosine_out * g_minus_cosine_out;
    float a_out = g_minus_cosine_out / g_plus_cosine_out;
    float cosine_g_plus_out = cosine_out * g_plus_cosine_out;
    float blender_fbm3_gold_brushed_noise_out = 0.0;
    mx_blender_fbm3_float(blender_fbm3_gold_brushed_noise_amplitude, blender_fbm3_gold_brushed_noise_octaves, blender_fbm3_gold_brushed_noise_lacunarity, blender_fbm3_gold_brushed_noise_diminish, noise_position_out, blender_fbm3_gold_brushed_noise_out);
    float b_denominator_out = cosine_g_minus_out + b_denominator_in2;
    float a_squared_out = a_out * a_out;
    float b_numerator_out = cosine_g_plus_out - b_numerator_in2;
    float brushed_gate_unclamped_out = brushed_gate_unclamped_outlow + (blender_fbm3_gold_brushed_noise_out - brushed_gate_unclamped_inlow) * (brushed_gate_unclamped_outhigh - brushed_gate_unclamped_outlow) / (brushed_gate_unclamped_inhigh - brushed_gate_unclamped_inlow);
    float half_a_squared_out = half_a_squared_in1 * a_squared_out;
    float b_out = b_numerator_out / b_denominator_out;
    float brushed_gate_out = clamp(brushed_gate_unclamped_out, brushed_gate_low, brushed_gate_high);
    float b_squared_out = b_out * b_out;
    float brushed_noise_contribution_out = brushed_gate_out * blender_fbm3_gold_brushed_noise_out;
    float one_plus_b_squared_out = one_plus_b_squared_in1 + b_squared_out;
    float brushed_add_out = brushed_add_in1 + brushed_noise_contribution_out;
    float layer_weight_fresnel_out = half_a_squared_out * one_plus_b_squared_out;
    float one_minus_brushed_add_out = one_minus_brushed_add_in1 - brushed_add_out;
    float one_minus_fresnel_out = one_minus_fresnel_in1 - layer_weight_fresnel_out;
    float lut_scaled_factor_out = layer_weight_fresnel_out * lut_scaled_factor_in2;
    float lut_centered_factor_out = lut_scaled_factor_out + lut_centered_factor_in2;
    vec2 lut_uv_out = vec2(lut_centered_factor_out,lut_uv_in2);
    float curve_ramp_response_out = 0.0;
    mx_image_float(curve_ramp_response_file, curve_ramp_response_layer, curve_ramp_response_default, lut_uv_out, curve_ramp_response_uaddressmode, curve_ramp_response_vaddressmode, curve_ramp_response_filtertype, curve_ramp_response_framerange, curve_ramp_response_frameoffset, curve_ramp_response_frameendaction, curve_ramp_response_uv_scale, curve_ramp_response_uv_offset, curve_ramp_response_out);
    float fresnel_response_out = layer_weight_fresnel_out * curve_ramp_response_out;
    float roughness_factor_out = one_minus_fresnel_out + fresnel_response_out;
    float authored_base_roughness_out = authored_base_roughness_in1 * roughness_factor_out;
    float one_minus_base_roughness_out = one_minus_base_roughness_in1 - authored_base_roughness_out;
    float screen_complement_out = one_minus_base_roughness_out * one_minus_brushed_add_out;
    float perceptual_roughness_out = perceptual_roughness_in1 - screen_complement_out;
    float active_perceptual_roughness_out = perceptual_roughness_out * active_perceptual_roughness_in2;
    vec3 gold_active_non_image_scalar_color_out = vec3(0.0);
    NG_convert_float_color3(active_perceptual_roughness_out, gold_active_non_image_scalar_color_out);
    surfaceshader surface_gold_active_non_image_scalar_out = surfaceshader(vec3(0.0),vec3(0.0));
    mx_surface_unlit(surface_gold_active_non_image_scalar_emission, gold_active_non_image_scalar_color_out, surface_gold_active_non_image_scalar_transmission, surface_gold_active_non_image_scalar_transmission_color, surface_gold_active_non_image_scalar_opacity, surface_gold_active_non_image_scalar_out);
    material MetalGoldActiveNonImageScalar_out = surface_gold_active_non_image_scalar_out;
    out1 = vec4(mx_srgb_encode(MetalGoldActiveNonImageScalar_out.color), 1.0);
}

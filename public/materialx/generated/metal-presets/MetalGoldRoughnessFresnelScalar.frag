#version 300 es

precision mediump float;


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
uniform int normal_world_fromspace;
uniform int normal_world_tospace;
uniform float g_squared_in2;
uniform float b_denominator_in2;
uniform float b_numerator_in2;
uniform float half_a_squared_in1;
uniform float one_plus_b_squared_in1;
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
uniform float perceptual_roughness_in1;
uniform float surface_gold_roughness_fresnel_scalar_emission;
uniform float surface_gold_roughness_fresnel_scalar_transmission;
uniform vec3 surface_gold_roughness_fresnel_scalar_transmission_color;
uniform float surface_gold_roughness_fresnel_scalar_opacity;

in vec3 normalObject;
in vec3 positionWorld;

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

void main()
{
    vec3 normal_object_out = normalize(normalObject);
    vec3 view_world_out = normalize(positionWorld - u_viewPosition);
    vec3 normal_world_out = (u_worldInverseTransposeMatrix * vec4(normal_object_out, 0.0)).xyz;
    normal_world_out = normalize(normal_world_out);
    float normal_dot_view_out = dot(normal_world_out, view_world_out);
    float cosine_out = abs(normal_dot_view_out);
    float cosine_squared_out = cosine_out * cosine_out;
    float g_squared_out = cosine_squared_out + g_squared_in2;
    float g_out = sqrt(g_squared_out);
    float g_minus_cosine_out = g_out - cosine_out;
    float g_plus_cosine_out = g_out + cosine_out;
    float cosine_g_minus_out = cosine_out * g_minus_cosine_out;
    float a_out = g_minus_cosine_out / g_plus_cosine_out;
    float cosine_g_plus_out = cosine_out * g_plus_cosine_out;
    float b_denominator_out = cosine_g_minus_out + b_denominator_in2;
    float a_squared_out = a_out * a_out;
    float b_numerator_out = cosine_g_plus_out - b_numerator_in2;
    float half_a_squared_out = half_a_squared_in1 * a_squared_out;
    float b_out = b_numerator_out / b_denominator_out;
    float b_squared_out = b_out * b_out;
    float one_plus_b_squared_out = one_plus_b_squared_in1 + b_squared_out;
    float layer_weight_fresnel_out = half_a_squared_out * one_plus_b_squared_out;
    float one_minus_fresnel_out = one_minus_fresnel_in1 - layer_weight_fresnel_out;
    float lut_scaled_factor_out = layer_weight_fresnel_out * lut_scaled_factor_in2;
    float lut_centered_factor_out = lut_scaled_factor_out + lut_centered_factor_in2;
    vec2 lut_uv_out = vec2(lut_centered_factor_out,lut_uv_in2);
    float curve_ramp_response_out = 0.0;
    mx_image_float(curve_ramp_response_file, curve_ramp_response_layer, curve_ramp_response_default, lut_uv_out, curve_ramp_response_uaddressmode, curve_ramp_response_vaddressmode, curve_ramp_response_filtertype, curve_ramp_response_framerange, curve_ramp_response_frameoffset, curve_ramp_response_frameendaction, curve_ramp_response_uv_scale, curve_ramp_response_uv_offset, curve_ramp_response_out);
    float fresnel_response_out = layer_weight_fresnel_out * curve_ramp_response_out;
    float roughness_factor_out = one_minus_fresnel_out + fresnel_response_out;
    float perceptual_roughness_out = perceptual_roughness_in1 * roughness_factor_out;
    vec3 roughness_fresnel_scalar_color_out = vec3(0.0);
    NG_convert_float_color3(perceptual_roughness_out, roughness_fresnel_scalar_color_out);
    surfaceshader surface_gold_roughness_fresnel_scalar_out = surfaceshader(vec3(0.0),vec3(0.0));
    mx_surface_unlit(surface_gold_roughness_fresnel_scalar_emission, roughness_fresnel_scalar_color_out, surface_gold_roughness_fresnel_scalar_transmission, surface_gold_roughness_fresnel_scalar_transmission_color, surface_gold_roughness_fresnel_scalar_opacity, surface_gold_roughness_fresnel_scalar_out);
    material MetalGoldRoughnessFresnelScalar_out = surface_gold_roughness_fresnel_scalar_out;
    out1 = vec4(mx_srgb_encode(MetalGoldRoughnessFresnelScalar_out.color), 1.0);
}

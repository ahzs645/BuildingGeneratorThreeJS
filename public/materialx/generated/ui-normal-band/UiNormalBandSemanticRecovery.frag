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
uniform mat4 u_worldInverseTransposeMatrix;
uniform int u_numActiveLightSources;

// Uniform block: PublicUniforms
uniform surfaceshader backsurfaceshader;
uniform displacementshader displacementshader1;
uniform int world_normal_fromspace;
uniform int world_normal_tospace;
uniform float normal_rotate_x_amount;
uniform vec3 normal_rotate_x_axis;
uniform float normal_rotate_y_amount;
uniform vec3 normal_rotate_y_axis;
uniform float normal_rotate_z_amount;
uniform vec3 normal_rotate_z_axis;
uniform vec3 normal_band_factor_in2;
uniform float normal_band_1_value2;
uniform vec3 normal_band_1_in1;
uniform vec3 normal_band_1_in2;
uniform float normal_band_2_value2;
uniform vec3 normal_band_2_in1;
uniform float normal_band_3_value2;
uniform vec3 normal_band_3_in1;
uniform float band_color_mix_mix;
uniform float surface_ui_normal_band_emission;
uniform float surface_ui_normal_band_transmission;
uniform vec3 surface_ui_normal_band_transmission_color;
uniform float surface_ui_normal_band_opacity;

in vec3 normalObject;
in vec3 i_geomprop_col;

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

mat4 mx_rotationMatrix(vec3 axis, float angle)
{
    axis = normalize(axis);
    float s = mx_sin(angle);
    float c = mx_cos(angle);
    float oc = 1.0 - c;

    return mat4(oc * axis.x * axis.x + c,           oc * axis.x * axis.y - axis.z * s,  oc * axis.z * axis.x + axis.y * s,  0.0,
                oc * axis.x * axis.y + axis.z * s,  oc * axis.y * axis.y + c,           oc * axis.y * axis.z - axis.x * s,  0.0,
                oc * axis.z * axis.x - axis.y * s,  oc * axis.y * axis.z + axis.x * s,  oc * axis.z * axis.z + c,           0.0,
                0.0,                                0.0,                                0.0,                                1.0);
}

void mx_rotate_vector3(vec3 _in, float amount, vec3 axis, out vec3 result)
{
    float rotationRadians = mx_radians(amount);
    mat4 m = mx_rotationMatrix(axis, rotationRadians);
    result = (m * vec4(_in, 1.0)).xyz;
}


void mx_surface_unlit(float emission, vec3 emission_color, float transmission, vec3 transmission_color, float opacity, out surfaceshader result)
{
    result.color = emission * emission_color * opacity;
    result.transparency = mix(vec3(1.0), transmission * transmission_color, opacity);
}

void main()
{
    vec3 object_normal_out = normalize(normalObject);
    vec3 geometry_color_out = i_geomprop_col;
    vec3 world_normal_out = (u_worldInverseTransposeMatrix * vec4(object_normal_out, 0.0)).xyz;
    world_normal_out = normalize(world_normal_out);
    vec3 normal_rotate_x_out = vec3(0.0);
    mx_rotate_vector3(world_normal_out, normal_rotate_x_amount, normal_rotate_x_axis, normal_rotate_x_out);
    vec3 normal_rotate_y_out = vec3(0.0);
    mx_rotate_vector3(normal_rotate_x_out, normal_rotate_y_amount, normal_rotate_y_axis, normal_rotate_y_out);
    vec3 normal_rotate_z_out = vec3(0.0);
    mx_rotate_vector3(normal_rotate_y_out, normal_rotate_z_amount, normal_rotate_z_axis, normal_rotate_z_out);
    float normal_band_factor_out = dot(normal_rotate_z_out, normal_band_factor_in2);
    vec3 normal_band_1_out = (normal_band_factor_out >= normal_band_1_value2) ? normal_band_1_in1 : normal_band_1_in2;
    vec3 normal_band_2_out = (normal_band_factor_out >= normal_band_2_value2) ? normal_band_2_in1 : normal_band_1_out;
    vec3 normal_band_3_out = (normal_band_factor_out >= normal_band_3_value2) ? normal_band_3_in1 : normal_band_2_out;
    vec3 band_color_mix_out = mix(normal_band_3_out, geometry_color_out, band_color_mix_mix);
    surfaceshader surface_ui_normal_band_out = surfaceshader(vec3(0.0),vec3(0.0));
    mx_surface_unlit(surface_ui_normal_band_emission, band_color_mix_out, surface_ui_normal_band_transmission, surface_ui_normal_band_transmission_color, surface_ui_normal_band_opacity, surface_ui_normal_band_out);
    material UiNormalBandSemanticRecovery_out = surface_ui_normal_band_out;
    out1 = vec4(mx_srgb_encode(UiNormalBandSemanticRecovery_out.color), 1.0);
}

#version 300 es

precision mediump float;


// Uniform block: PrivateUniforms
uniform mat4 u_worldMatrix;
uniform mat4 u_viewProjectionMatrix;
uniform mat4 u_worldInverseTransposeMatrix;

// Inputs block: VertexInputs
in vec3 i_position;
in vec3 i_normal;
in vec3 i_tangent;

out vec3 normalWorld;
out vec3 tangentWorld;
out vec3 positionWorld;

void main()
{
    vec4 hPositionWorld = u_worldMatrix * vec4(i_position, 1.0);
    gl_Position = u_viewProjectionMatrix * hPositionWorld;
    normalWorld = normalize((u_worldInverseTransposeMatrix * vec4(i_normal, 0.0)).xyz);
    tangentWorld = normalize((u_worldMatrix * vec4(i_tangent, 0.0)).xyz);
    positionWorld = hPositionWorld.xyz;
}

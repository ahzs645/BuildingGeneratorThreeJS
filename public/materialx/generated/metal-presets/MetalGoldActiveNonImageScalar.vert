#version 300 es

precision highp float;


// Uniform block: PrivateUniforms
uniform mat4 u_worldMatrix;
uniform mat4 u_viewProjectionMatrix;

// Inputs block: VertexInputs
in vec3 i_position;
in vec3 i_normal;

out vec3 normalObject;
out vec3 positionWorld;
out vec3 positionObject;

void main()
{
    vec4 hPositionWorld = u_worldMatrix * vec4(i_position, 1.0);
    gl_Position = u_viewProjectionMatrix * hPositionWorld;
    normalObject = i_normal;
    positionWorld = hPositionWorld.xyz;
    positionObject = i_position;
}

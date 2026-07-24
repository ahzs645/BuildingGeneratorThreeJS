#version 300 es

precision mediump float;


// Uniform block: PrivateUniforms
uniform mat4 u_worldMatrix;
uniform mat4 u_viewProjectionMatrix;

// Inputs block: VertexInputs
in vec3 i_position;
in vec3 i_normal;
in vec3 a_geomprop_col;

out vec3 normalObject;
out vec3 i_geomprop_col;

void main()
{
    vec4 hPositionWorld = u_worldMatrix * vec4(i_position, 1.0);
    gl_Position = u_viewProjectionMatrix * hPositionWorld;
    normalObject = i_normal;
    i_geomprop_col = a_geomprop_col;
}

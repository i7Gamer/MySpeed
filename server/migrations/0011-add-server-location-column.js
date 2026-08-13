import { DataTypes } from 'sequelize';

/**
 * Where the server is, as opposed to who runs it.
 *
 * `serverName` holds what the Ookla CLI calls the server's name, which is the
 * sponsor - "Salt Mobile SA" - while the city is a separate field the parser
 * was throwing away. The CLI keeps them apart in its own server list
 * ({"name":"Salt Mobile SA","location":"Glattbrugg"}) and prints the pair
 * together in its CSV output, so a history could say which company answered
 * but not from where, and two tests could not be compared for whether the
 * traffic had moved city. Upstream #1250 asks for the location by name.
 *
 * Only Ookla reports it. LibreSpeed's result names its backend and its URL and
 * nothing about where it is, and Cloudflare's colo airport code is already the
 * server's name on those rows - so null there means "this provider does not
 * say", exactly as it does for the quality figures.
 *
 * Null on every row recorded before the column existed, which genuinely cannot
 * say either.
 */
export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('speedtests');

    if (!tableDescription.serverLocation)
        await queryInterface.addColumn('speedtests', 'serverLocation', {
            type: DataTypes.STRING,
            allowNull: true,
            defaultValue: null
        });
}

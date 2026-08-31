import { DataTypes } from 'sequelize';

// Whether an iperf3 target measures with datagrams instead of a stream, and at
// what rate when it does.
//
// The flag is NOT NULL with a default, unlike the two columns 0015 added, and
// the difference is deliberate: a duration of null means "inherit the shipped
// default", while a run is either UDP or it is not. Every target that exists
// runs TCP, and false says so rather than leaving a third state for later code
// to interpret.
//
// The rate is nullable because it belongs to the flag: null is "this target
// sends no datagrams", and the door refuses the two rows that disagree - UDP
// with no rate, and a rate with no UDP.
const COLUMNS = [
    {name: "iperfUdp", options: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false}},
    {name: "iperfBitrate", options: {type: DataTypes.INTEGER, allowNull: true, defaultValue: null}}
];

export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('targets');

    for (const column of COLUMNS) {
        if (!tableDescription[column.name]) {
            await queryInterface.addColumn('targets', column.name, column.options);
        }
    }
}

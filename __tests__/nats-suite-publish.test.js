const nats = require('nats');

// Capture the registered node constructor
let NatsPublishNode;

// Mock Node-RED
const mockRED = {
  nodes: {
    createNode: jest.fn(),
    getNode: jest.fn(),
    registerType: jest.fn((name, constructor) => {
      NatsPublishNode = constructor;
    }),
  },
};

// Mock NATS connection
const mockNatsConnection = {
  publish: jest.fn(),
  close: jest.fn(),
};

jest.mock('nats', () => ({
  connect: jest.fn(() => Promise.resolve(mockNatsConnection)),
  StringCodec: jest.fn(() => ({
    encode: jest.fn(data => Buffer.from(String(data))),
    decode: jest.fn(data => data.toString()),
  })),
}));

describe('NATS Publish Node', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear module cache and re-require to get fresh registration
    delete require.cache[require.resolve('../nodes/nats-suite-publish')];
    require('../nodes/nats-suite-publish')(mockRED);
  });

  test('should register the node type', () => {
    expect(mockRED.nodes.registerType).toHaveBeenCalledWith('nats-suite-publish', expect.any(Function));
  });

  test('should create node with correct configuration', () => {
    const config = {
      server: 'test-server',
      dataformat: 'uns_value',
      datapointid: 'test.datapoint',
      name: 'Test Node',
    };

    // Mock getNode to return a server config
    mockRED.nodes.getNode.mockReturnValue({
      getConnection: jest.fn(() => Promise.resolve(mockNatsConnection)),
      addStatusListener: jest.fn(),
      registerConnectionUser: jest.fn(),
      unregisterConnectionUser: jest.fn(),
    });

    const node = {
      status: jest.fn(),
      on: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    NatsPublishNode.call(node, config);
    
    expect(mockRED.nodes.createNode).toHaveBeenCalled();
  });
});

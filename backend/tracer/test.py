class Node:

    def __init__(self, data):
        self.data = data
        self.left = None
        self.right = None


root = Node(10)
root.left = Node(5)
root.right = Node(20)

print(root.data)
print(root.left.data)
print(root.right.data)